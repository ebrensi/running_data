/*
 * Strava related stuff
*/

function stravaActivityURL( id ) {
    return `https://www.strava.com/activities/${id}`;
}

function stravaAthleteURL( id ) {
    return `https://www.strava.com/athletes/${id}`;
}

const ATYPE = {
    // This is a list of tuples specifying properties of the rendered objects,
    //  such as path color, speed/pace in description.  others can be added
    _specs: {
        "canoeing": [null, null],
        "crossfit": [null, null], 
        "ebikeride": ["speed", "#0000cd"], // mediumblue  
        "elliptical": [null, null],   
        "golf": [null, null],
        "handcycle": [null, null],  
        "hike": ["pace", "#ff1493"],   // deeppink    
        "iceskate": ["speed", "#663399"],  // rebeccapurple   
        "inlineskate": [null, "#8a2be2"],  // blueviolet  
        "kayaking": [null, "#ffa500"],  // orange 
        "kitesurf": ["speed", null],  
        "nordicski": [null, "#800080"], // purple 
        "ride": ["speed", "#2b60de"],  // ocean blue  
        "rockclimbing": [null, "#4b0082", "climbing"],  // indigo 
        "rollerski": ["speed", "#800080"],  // purple 
        "rowing": ["speed", "#fa8072"],  // salmon    
        "run": ["pace", "#ff0000"],    // red    
        "sail": [null, null], 
        "skateboard": [null, null], 
        "snowboard": [null, "#00ff00"],  // lime  
        "snowshoe": ["pace", "#800080"], // purple    
        "soccer": [null, null],
        "stairstepper": [null, null], 
        "standuppaddling": [null, null, "paddling"],  
        "surfing": [null, "#006400"],  // darkgreen   
        "swim": ["speed", "#00ff7f"],  // springgreen 
        "velomobile": [null, null],
        "virtualride": ["speed", "#1e90ff"],  // dodgerblue   
        "virtualrun": [null, null],
        "walk": ["pace", "#ff00ff"],   // fuchsia 
        "weighttraining": [null, null, 'weights'],   
        "wheelchair": [null, null], 
        "windsurf": ["speed", null],  
        "workout": [null, null],  
        "yoga": [null, null],  
        "undefined": [null, null] 
    },

    types: function() {
        return Object.keys(this._specs)
    }, 

    specs: function(A) {
        const atype = A.type.toLowerCase(),
              spec = this._specs[atype] || this._specs[undefined];
              
        return {"atype": spec[0], "pathColor": spec[1], "type": spec[2] || A.type}
    }

};


