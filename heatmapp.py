#! usr/bin/env python

from flask import Flask, Response, render_template, request, redirect, jsonify,\
    url_for, abort, session, flash, g
import flask_compress
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from datetime import date, timedelta
import os
import stravalib
import polyline
import flask_login
from flask_login import current_user, login_user, logout_user, login_required

app = Flask(__name__)
app.config.from_object(os.environ['APP_SETTINGS'])

# views will be sent as gzip encoded
flask_compress.Compress(app)

# initialize database
db = SQLAlchemy(app)

# data models defined in models.py
from models import User, Activity
migrate = Migrate(app, db)

# Strava client
client = stravalib.Client()

# Flask-login stuff
login_manager = flask_login.LoginManager()
login_manager.init_app(app)


@login_manager.user_loader
def load_user(name):
    return User.get(name)


@app.route('/')
def nothing():
    return redirect(url_for('login'))


# Display the login page
@app.route("/login", methods=["GET"])
def login():
    return render_template("login.html")


# Attempt to authorize a user via Oauth(2) or whatever
@app.route('/authorize/<service>')
def authorize(service):
    redirect_uri = url_for('auth_callback', service=service, _external=True)

    if service == 'strava':
        auth_url = client.authorization_url(client_id=app.config["STRAVA_CLIENT_ID"],
                                            redirect_uri=redirect_uri,
                                            approval_prompt="force",
                                            state=request.args.get("next"))
        return redirect(auth_url)


# Authorization callback.  The service returns here to give us an access_token
#  for the user who successfully logged in.
@app.route('/authorized/<service>')
def auth_callback(service):
    if "error" in request.args:
        error = request.args["error"]
        flash("Error: {}".format(error))
        return redirect(url_for("login"))

    if current_user.is_anonymous:
        if service == "strava":
            args = {"code": request.args.get("code"),
                    "client_id": app.config["STRAVA_CLIENT_ID"],
                    "client_secret": app.config["STRAVA_CLIENT_SECRET"]}
            access_token = client.exchange_code_for_token(**args)
            client.access_token = access_token

            strava_user = client.get_athlete()
            user = User.get(strava_user.username)

            if not user:
                # If this user isn't in the database we create an account
                strava_user_info = {"id": strava_user.id,
                                    "firstname": strava_user.firstname,
                                    "lastname": strava_user.lastname,
                                    "username": strava_user.username,
                                    "pic_url": strava_user.profile,
                                    "access_token": access_token
                                    }
                user = User(name=strava_user.username,
                            strava_user_data=strava_user_info)
                db.session.add(user)
                db.session.commit()

            elif access_token != user.strava_user_data["access_token"]:
                # if user exists but the access token has changed, update it
                user.strava_user_data["access_token"] = access_token
                db.session.commit()

            # I think this is remember=True, for persistent login. not sure
            login_user(user, True)

    return redirect(url_for("index", username=current_user.name))


@app.route("/logout")
@login_required
def logout():
    if not current_user.is_anonymous:
        username = current_user.name
        client.access_token = None
        logout_user()
        flash("{} logged out".format(username))
    return redirect(url_for("login"))


@app.route("/<username>/delete")
@login_required
def delete(username):
    if username == current_user.name:
        # log out current user
        client.access_token = None
        logout_user()

        # that user is no longer the current user
        user = User.get(username)
        db.session.delete(user)
        db.session.commit()
        flash("user '{}' deleted".format(username))
    else:
        flash("you ({}) are not authorized to delete user {}"
              .format(current_user.name, username))

    return redirect(url_for("login"))


@app.route('/<username>')
def index(username):
    return render_template('index.html',
                           username=username)


@app.route('/<username>/points.json')
def pointsJSON(username):
    tomorrow = (date.today() + timedelta(1)).strftime('%Y-%m-%d')
    today = date.today().strftime('%Y-%m-%d')

    start = request.args.get("start", today)
    end = request.args.get("end", tomorrow)

    user = User.get(username)
    points = [[row[0], row[1]] for row in get_points(user, start, end)]
    resp = jsonify(points)
    resp.status_code = 200

    return resp


def get_points(user, start=None, end=None):
    # TODO: make sure datetimes are valid and start <= finish
    # query = """
    #         SELECT  lat, lng
    #         FROM (
    #             SELECT elapsed, lat, lng
    #             FROM(
    #                 SELECT unnest(elapsed) AS elapsed,
    #                        unnest(latitudes) AS lat,
    #                        unnest(longitudes) AS lng
    #                 FROM %s
    #                 WHERE user_name == '%s'
    #                   AND begintimestamp >= '%s'
    #                   AND begintimestamp <= '%s'
    #                 ) AS sub
    #             ) AS sub2
    #         WHERE lat <> 0 AND lng <> 0;
    #         """ % (Activity.__tablename__, user.name, start, end)

    result = db.session.query(db.func.unnest(Activity.latitudes),
                              db.func.unnest(Activity.longitudes))
    result = result.filter_by(user=user)
    result = result.filter(Activity.beginTimestamp.between(start, end))

    return result


def get_points2(user, start=None, end=None):
    result = db.session.query(Activity.polyline)
    result = result.filter_by(user=user)
    result = result.filter(Activity.beginTimestamp.between(start, end))

    app.logger.info(result)
    # return (point for point in (polyline.decode(pl) for pl in result))
    for pl in result:
        points = polyline.decode(pl)
        for point in points:
            yield point


@app.route('/activity_import')
@login_required
def activity_import():
    user = current_user

    clean = request.args.get("clean")
    count = request.args.get("count")
    service = request.args.get("service")

    if service == "gc":
        import gcimport
        if clean:
            return "<h1>{}: clear data for {} and import {} most recent activities</h1>".format(service, user_name, count)
        else:
            do_import = gcimport.import_activities(db, user, count=count)
            return Response(do_import, mimetype='text/event-stream')

    elif service == "strava":
        return redirect(url_for("strava_activities",
                                limit=count,
                                really="yes"))


@app.route('/strava_activities')
@login_required
def strava_activities():
    user = User.get(current_user.name)

    already_got = [int(d[0]) for d in db.session.query(
        Activity.id).filter_by(user=user).all()]
    app.logger.info("already_got: %s", already_got)

    limit = request.args.get("limit")
    limit = int(limit) if limit else ""

    really = (request.args.get("really") == "yes")

    def do_import():
        count = 0
        yield "importing activities from Strava...\n"
        for a in client.get_activities(limit=limit):
            count += 1

            if a.id in already_got:
                msg = "{}. activity {} already in database.".format(count, a.id)
                yield msg + "\n"
            else:
                if really:
                    try:
                        streams = client.get_activity_streams(a.id,
                                                              types=['time', 'latlng'])
                    except:
                        yield "activity {} has no data points".format(a.id)
                    else:
                        time = streams["time"].data

                        # eliminate (0,0) points
                        latlng = [(x, y) for x, y in streams["latlng"].data
                                  if (x, y) != (0, 0)]

                        lat, lng = zip(*latlng)
                        poly = polyline.encode(latlng)
                        other = {"name": a.name}
                        params = {"user": user,
                                  "id": a.id,
                                  "other": other,
                                  "beginTimestamp": a.start_date_local,
                                  "elapsed": time,
                                  "latitudes": list(lat),
                                  "longitudes": list(lng),
                                  "polyline": poly,
                                  "source": "ST"}

                        # app.logger.info("params: %s", params)
                        A = Activity(**params)
                        db.session.add(A)
                        db.session.commit()

                        mi = stravalib.unithelper.miles(a.distance)
                        msg = ("[{0.id}] {0.name}: {0.start_date_local}"
                               .format(a))
                        msg = "{}. {}, {}\n".format(count, msg, mi)
                        yield msg

        yield "Done! {} activities imported\n".format(count)

    return Response(do_import(), mimetype='text/event-stream')


# python heatmapp.py works but you really should use `flask run`
if __name__ == '__main__':
    app.run()
