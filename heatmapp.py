#! usr/bin/env python
from __future__ import unicode_literals

import polyline
# from gevent.pool import Pool
from flask import Flask, Response, render_template, request, redirect, \
    jsonify, url_for, flash, send_from_directory
import flask_compress

from datetime import datetime, timedelta
import dateutil.parser
import os
import re
import json
import itertools
import stravalib
import flask_login
from flask_login import current_user, login_user, logout_user, login_required
import flask_assets
from flask_analytics import Analytics
import flask_caching
from signal import signal, SIGPIPE, SIG_DFL
from sqlalchemy import or_, and_
from requests.exceptions import HTTPError
from sqlalchemy.exc import InvalidRequestError
# "too many connections" and  "duplicate key value violates unique constraint"
from psycopg2 import OperationalError, IntegrityError

# makes python ignore sigpipe? prevents broken pipe exception when client
#  aborts an SSE stream
signal(SIGPIPE, SIG_DFL)

app = Flask(__name__)
app.config.from_object(os.environ['APP_SETTINGS'])

# set up short-term fast caching support
cache = flask_caching.Cache(app)
cache.clear()

# models depend on cache and app so we import them afterwards
from models import User, Activity, db, inspector
db.create_all()

Analytics(app)

# we bundle javascript and css dependencies to reduce client-side overhead
bundles = {
    "index_css": flask_assets.Bundle('css/jquery-ui.css',
                                     'css/bootstrap.min.css',
                                     'css/font-awesome.min.css',
                                     'css/leaflet.css',
                                     'css/leaflet-sidebar.css',
                                     'css/L.Control.Window.css',
                                     'css/L.Control.Locate.min.css',
                                     filters='cssmin',
                                     output='gen/index.css'),

    "index_js": flask_assets.Bundle('js/jquery-3.1.0.min.js',
                                    'js/jquery-ui.min.js',
                                    'js/leaflet.js',
                                    'js/leaflet-sidebar.js',
                                    'js/Polyline.encoded.js',
                                    'js/leaflet.spin.js',
                                    'js/spin.min.js',
                                    'js/moment.js',
                                    'js/leaflet-heat.js',
                                    'js/leaflet-ant-path.js',
                                    'js/L.Control.Window.js',
                                    'js/leaflet-providers.js',
                                    'js/Leaflet.GoogleMutant.js',
                                    'js/L.Control.Locate.min.js',
                                    filters='rjsmin',
                                    output='gen/index.js')

}
assets = flask_assets.Environment(app)
assets.register(bundles)


# views will be sent as gzip encoded
flask_compress.Compress(app)


# Flask-login stuff
login_manager = flask_login.LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'nothing'


@login_manager.user_loader
def load_user(user_id):
    user = db.session.merge(User.get(user_id), load=False)
    # app.logger.debug(inspector(user))
    # app.logger.debug(user.describe())
    return user


@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'),
                               'favicon.ico')


@app.route('/apple-touch-icon')
def touch():
    return send_from_directory(os.path.join(app.root_path, 'static'),
                               'Heat.png')


@app.route('/')
def nothing():
    if current_user.is_authenticated:
        try:
            assert current_user.strava_id
        except:
            # If a user is logged in but has no record in our database.
            #  i.e. was deleted.  We direct them to initialize a new account.
            logout_user()
            flash("oops! Please log back in.")
        else:
            return redirect(url_for('index',
                                    username=current_user.strava_id))

    return render_template("splash.html")


@app.route('/demo')
def demo():
    return redirect(url_for("index",
                            username="15972102",
                            preset="7",
                            heatres="high",
                            flowres="high",
                            autozoom=1,
                            # baselayer=["OpenTopoMap"]
                            )
                    )


# Attempt to authorize a user via Oauth(2)
@app.route('/authorize')
def authorize():
    state = request.args.get("state")
    redirect_uri = url_for('auth_callback', _external=True)

    client = stravalib.Client()
    auth_url = client.authorization_url(
        client_id=app.config["STRAVA_CLIENT_ID"],
        redirect_uri=redirect_uri,
        # approval_prompt="force",
        state=state
    )
    return redirect(auth_url)


# Authorization callback.  The service returns here to give us an access_token
#  for the user who successfully logged in.
@app.route('/authorized')
def auth_callback():
    state = request.args.get("state")

    if "error" in request.args:
        error = request.args["error"]
        flash("Error: {}".format(error))
        return redirect(state)

    if current_user.is_anonymous:
        args = {"code": request.args.get("code"),
                "client_id": app.config["STRAVA_CLIENT_ID"],
                "client_secret": app.config["STRAVA_CLIENT_SECRET"]}
        client = stravalib.Client()
        try:
            access_token = client.exchange_code_for_token(**args)

        except Exception as e:
            app.logger.info(str(e))
            flash(str(e))
            return redirect(state)

        user = User.from_access_token(access_token)
        app.logger.debug("created {}. inspect: {}".format(user.describe(),
                                                          inspector(user)))
        db.session.add(user)
        db.session.commit()
        app.logger.debug(inspector(user))

        # remember=True, for persistent login.
        login_user(user, remember=True)

    return redirect(request.args.get("state") or
                    url_for("index", username=current_user.strava_id))


@app.route("/logout")
@login_required
def logout():
    if current_user.is_authenticated:
        user_id = current_user.strava_id
        username = current_user.username
        current_user.uncache()
        logout_user()
        flash("user '{}' ({}) logged out"
              .format(username, user_id))
    return redirect(request.args.get("next") or url_for("nothing"))


@app.route("/delete")
@login_required
def delete():
    if current_user.is_authenticated:
        username = current_user.username
        user_id = current_user.strava_id
        logout_user()

        # the current user is now logged out
        user = User.get(user_id)
        try:
            user.uncache()
            db.session.delete(user)
            db.session.commit()
        except Exception as e:
            flash(str(e))
        else:
            flash("user '{}' ({}) deleted".format(username, user_id))
    return redirect(url_for("nothing"))


@app.route('/<username>')
def index(username):
    if current_user.is_authenticated:
        # If a user is logged in from a past session but has no record in our
        #  database (was deleted), we log them out and consider them anonymous
        try:
            assert current_user.strava_id
        except:
            logout_user()
        else:
            current_user.dt_last_active = datetime.utcnow()
            current_user.app_activity_count += 1
            db.session.commit()

    # note: 'current_user' is the user that is currently logged in.
    #       'user' is the user we are displaying data for.
    user = User.get(username)
    if not user:
        flash("user '{}' is not registered with this app"
              .format(username))
        return redirect(url_for('nothing'))

    date1 = request.args.get("date1", "")
    date2 = request.args.get("date2", "")
    preset = request.args.get("preset", "")
    limit = request.args.get("limit", "")
    baselayer = request.args.getlist("baselayer")
    ids = request.args.get("id", "")

    if not ids:
        if (not date1) and (not date2):
            if preset:
                try:
                    preset = int(preset)
                except:
                    flash("'{}' is not a valid preset".format(preset))
                    preset = 7
            elif limit:
                try:
                    limit = int(limit)
                except:
                    flash("'{}' is not a valid limit".format(limit))
                    limit = 1
            else:
                limit = 5

    flowres = request.args.get("flowres", "")
    heatres = request.args.get("heatres", "")
    if (not flowres) and (not heatres):
        flowres = "low"
        heatres = "low"

    lat = request.args.get("lat")
    lng = request.args.get("lng")
    zoom = request.args.get("zoom")
    autozoom = request.args.get("autozoom")

    if (not lat) or (not lng):
        lat, lng = app.config["MAP_CENTER"]
        zoom = app.config["MAP_ZOOM"]
        autozoom = "1"

    return render_template('index.html',
                           user=user,
                           lat=lat,
                           lng=lng,
                           zoom=zoom,
                           ids=ids,
                           preset=preset,
                           date1=date1,
                           date2=date2,
                           limit=limit,
                           heatres=heatres,
                           flowres=flowres,
                           autozoom=autozoom,
                           baselayer=baselayer
                           )


@app.route('/<username>/getdata')
def getdata(username):
    user = User.get(username)

    def sse_out(obj=None):
        data = json.dumps(obj) if obj else "done"
        return "data: {}\n\n".format(data)

    def errout(msg):
        # outputs a terminating SSE stream consisting of one error message
        data = {"error": "{}".format(msg)}
        return Response(itertools.imap(sse_out, data, None),
                        mimetype='text/event-stream')

    def cast_int(s):
        try:
            return int(s)
        except:
            return

    if not user:
        return errout("'{}' is not registered with this app".format(username))

    options = {}
    ids_raw = request.args.get("id")
    if ids_raw:
        non_digit = re.compile("\D")

        ids = [s for s in [cast_int(s) for s in non_digit.split(ids_raw)]
               if s]

        app.logger.debug("'{}' => {}".format(ids_raw, ids))
        options["activity_ids"] = ids
    else:
        limit = request.args.get("limit")
        if limit:
            options["limit"] = int(limit)
            if limit == 0:
                limit == 1

        date1 = request.args.get("date1")
        date2 = request.args.get("date2")
        if date1 or date2:
            try:
                options["after"] = dateutil.parser.parse(date1)
                if date2:
                    options["before"] = dateutil.parser.parse(date2)
                    assert(options["before"] > options["after"])
            except:
                return errout("Invalid Dates")
        elif not limit:
            options["limit"] = 10

    hires = request.args.get("hires") == "true"

    app.logger.debug("getdata: {}, hires={}".format(options, hires))

    def path_color(activity_type):
        color_list = [color for color, activity_types
                      in app.config["ANTPATH_ACTIVITY_COLORS"].items()
                      if activity_type.lower() in activity_types]

        return color_list[0] if color_list else ""

    # pool = Pool(app.config["CONCURRENCY"])
    client = user.client()
    # jobs = []

    def import_streams(activity_id):
        stream_names = ['time', 'latlng', 'altitude']

        try:
            streams = client.get_activity_streams(activity_id,
                                                  types=stream_names)
        except Exception as e:
            app.logger.debug(e)
            return {"error": str(e)}

        activity_streams = {name: streams[name].data for name in streams}

        if "latlng" in activity_streams:
            activity_streams["polyline"] = polyline.encode(
                activity_streams['latlng'])
        return activity_streams

    def sse_iterator():
        relevant_streams = ["polyline"]

        for activity in user.activity_summaries(**options):
            # app.logger.debug("activity {}".format(activity))
            if ("error" not in activity) and activity.get("summary_polyline"):
                activity["path_color"] = path_color(activity["type"])

                if hires and ("polyline" not in activity):
                    data = Activity.get_data(activity["id"], relevant_streams)

                    if data:
                        data.update(activity)
                        # app.logger.debug("sending {}".format(data))
                        yield sse_out(data)

                    else:
                        yield sse_out({
                            "msg": "importing [{id}] {name}..."
                            .format(**activity)
                        })

                        activity_data = import_streams(activity["id"])
                        activity_data.update(activity)
                        A = Activity.new(**activity_data)
                        A = db.session.merge(A)
                        A.user = user
                        db.session.add(A)
                        db.session.commit()  # getting IntegrityError here sometimes

                        data = A.data(relevant_streams)
                        data.update(activity)
                        yield sse_out(data)
                else:
                    yield sse_out(activity)
        yield sse_out()

    return Response(sse_iterator(), mimetype='text/event-stream')


# creates a SSE stream of current.user's activities, using the Strava API
# arguments
@app.route('/activities_sse')
@login_required
def activity_stream():
    user = User.get(current_user.strava_id)
    options = {}

    if "id" in request.args:
        options["activity_ids"] = request.args.getlist("id")
    else:
        if "friends" in request.args:
            options["friends"] = True

        if "before" in request.args:
            options["before"] = dateutil.parser.parse(
                request.args.get("before"))

        if "after" in request.args:
            options["after"] = dateutil.parser.parse(request.args.get("after"))

        if "limit" in request.args:
            options["limit"] = int(request.args.get("limit"))

    def boo():
        for a in user.activity_summaries(**options):
            # a["cached"] = "yes" if Activity.query.get(a['id']) else "no"
            yield "data: {}\n\n".format(json.dumps(a))
        yield "data: done\n\n"

    return Response(boo(), mimetype='text/event-stream')


@app.route('/activities')
@login_required
def activities():
    return render_template("activities.html",
                           limit=request.args.get("limit"))


@app.route('/activities/<activity_id>')
@login_required
def data_points(activity_id):
    return redirect("https://www.strava.com/activities/{}".format(activity_id))


@app.route('/retrieve_list', methods=['POST'])
def retrieve_list():
    data = {
        "import": request.form.getlist("to")
    }

    return jsonify(data)


@app.route('/purge_old_activities')
@login_required
def old():
    if current_user.strava_id not in app.config["ADMIN"]:
        return jsonify({"error": "oops.  Can't do this."})
    days = app.config["DB_CACHE_TIMEOUT"]
    deleted_count = purge_old_activities(days)
    msg = ("purged {} activities over {} days old.  {} remaining."
           .format(deleted_count, days, Activity.query.count()))
    return msg


def purge_old_activities(days=app.config["DB_CACHE_TIMEOUT"]):
    now = datetime.utcnow()
    past_time = now - timedelta(days=days)
    old_activities = (
        Activity.query.filter(or_(Activity.dt_last_accessed < past_time,
                                  and_(Activity.dt_cached < past_time,
                                       Activity.dt_last_accessed == None)))
    )
    count = old_activities.delete()
    db.session.commit()
    msg = "purged {} activities over {} days old.".format(count, days)
    app.logger.info(msg)
    return count


@app.route('/users')
@login_required
def users():
    info = {
        user.strava_id: {
            "cached": user.activities.count(),
            "dt_last_active": user.dt_last_active,
            "app_activity_count": user.app_activity_count,
            "username": user.username
        }
        for user in User.query}
    return jsonify(info)


@app.route('/clear_cache')
@login_required
def clear_cache():
    if current_user.strava_id in app.config["ADMIN"]:
        cache.clear()
        return "cache cleared"
    else:
        return "sorry."


#  Webhook Subscription stuff.  Only admin users can access this
@app.route('/subscription/<operation>')
@login_required
def subscription(operation):
    if current_user.strava_id not in app.config["ADMIN"]:
        return jsonify({"error": "oops.  Can't do this."})

    client = stravalib.Client()
    credentials = {
        "client_id": app.config["STRAVA_CLIENT_ID"],
        "client_secret": app.config["STRAVA_CLIENT_SECRET"]
    }
    if operation == "create":
        try:
            sub = client.create_subscription(
                callback_url=url_for("webhook_callback", _external=True),
                **credentials
            )
        except Exception as e:
            return jsonify({"error": str(e)})

        return jsonify({"created": str(sub)})

    elif operation == "list":
        subs = client.list_subscriptions(**credentials)
        return jsonify([str(sub) for sub in subs])

    elif operation == "delete":
        try:
            subscription_id = int(request.args.get("id"))
        except:
            response = {"error": "bad or missing subscription id"}
        else:
            try:
                # if successful this will be null
                response = client.delete_subscription(subscription_id,
                                                      **credentials)
            except Exception as e:
                response = {"error": str(e)}

        return jsonify(response)


@app.route('/webhook_callback', methods=["GET", "POST"])
def webhook_callback():
    client = stravalib.Client()

    if request.method == 'GET':
        return client.handle_subscription_callback(request.args)

    elif request.method == 'POST':
        update_raw = request.get_json(force=True)
        app.logger.info("subscription: ".format(update_raw))
        update = client.handle_subscription_update(update_raw)
        # handle_update.delay(update)
        return "success"


# python heatmapp.py works but you really should use `flask run`
if __name__ == '__main__':
    app.run()
