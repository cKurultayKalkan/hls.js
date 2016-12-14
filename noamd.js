(function(){
    'use strict';
    var name = 'hls', fs = require('fs');
    var s = 'else if(typeof define==="function"&&define.amd){define([],f)}';
    function strip(file){
        fs.writeFileSync(file,
            fs.readFileSync(file, 'utf-8').replace(s, ''), 'utf-8');
    }
    strip(__dirname+'/dist/'+name+'.js');
}());
