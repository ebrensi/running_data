L.AreaSelect2 = L.Class.extend({
    includes: L.Mixin.Events,

    options: {

    },

    initialize: function(options,doneSelecting=null, whileSelecting=null) {
        L.Util.setOptions(this, options);
        this.onmousemove = whileSelecting;
        this.onmouseup = doneSelecting;
    },

    addTo: function(map) {
        this.map = map;

        let size = map.getSize();

        this.drag = false;

        this.canvas = L.DomUtil.create( "canvas", "leaflet-layer" );
        canvas = this.canvas;
        map._panes.markerPane.appendChild( canvas );

        canvas.width = size.x;
        canvas.height = size.y;

        this.ctx = canvas.getContext('2d');
        this.ctx.globalAlpha = 0.3;
        this.ctx.fillStyle = "red";

        this.map.dragging.disable();

        canvas.onmousedown = function(event){
            let topLeft = this.map.containerPointToLayerPoint( [ 0, 0 ] );
            L.DomUtil.setPosition( this.canvas, topLeft );

            this.mapPanePos = this.map._getMapPanePos();

            this.rect = {};
            this.dragging = true;
            this.rect.startX = event.pageX;
            this.rect.startY = event.pageY;
        }.bind(this);


        canvas.onmousemove = function(event){
            if (this.dragging) {
                this.rect.w = event.pageX - this.rect.startX;
                this.rect.h = event.pageY - this.rect.startY;

                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

                let rect = this.rect,
                    corner = new L.Point(rect.startX, rect.startY);

                this.ctx.fillRect(corner.x, corner.y, rect.w, rect.h);

                this.onmousemove && this.onmousemove(this.getBounds());
            }
        }.bind(this);


        canvas.onmouseup = function(event){
            this.dragging = false;
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            this.onmouseup & this.onmouseup(this.getBounds());
        }.bind(this);


        if (touchHandler) {
            // make touch events simulate mouse events via touchHandler
            canvas.addEventListener("touchstart", touchHandler, true);
            canvas.addEventListener("touchmove", touchHandler, true);
            canvas.addEventListener("touchend", touchHandler, true);
            canvas.addEventListener("touchcancel", touchHandler, true);
        }

    },

    getBounds: function() {
        let r = this.rect,
            corner1 = new L.Point(r.startX, r.startY),
            corner2 = new L.Point(r.startX + r.w, r.startY + r.h),
            pxBounds = new L.Bounds(corner1, corner2),

            ll1 = this.map.containerPointToLatLng(corner1),
            ll2 = this.map.containerPointToLatLng(corner2),
            llBounds = new L.LatLngBounds(ll1, ll2);

        return {pxBounds: pxBounds, latLngBounds: llBounds};
    },

    remove: function() {
        map._panes.markerPane.removeChild( this.canvas );
        this.canvas = null;
        self.map.dragging.enable();
    }
});

L.areaSelect2 = function(options) {
    return new L.AreaSelect2(options);
}
