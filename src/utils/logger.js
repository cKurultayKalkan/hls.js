'use strict';

function noop() {}

const fakeLogger = {
  trace: noop,
  debug: noop,
  log: noop,
  warn: noop,
  info: noop,
  error: noop
};

let exportedLogger = fakeLogger, hls;

//let lastCallTime;
// function formatMsgWithTimeInfo(type, msg) {
//   const now = Date.now();
//   const diff = lastCallTime ? '+' + (now - lastCallTime) : '0';
//   lastCallTime = now;
//   msg = (new Date(now)).toISOString() + ' | [' +  type + '] > ' + msg + ' ( ' + diff + ' ms )';
//   return msg;
// }

function formatMsg(type, msg) {
  msg = '[' +  type + '] > ' + msg;
  return msg;
}

function consolePrintFn(type) {
  const func = window.console[type];
  if (func) {
    return function(...args) {
      if(args[0]) {
        args[0] = formatMsg(type, args[0]);
      }
      func.apply(window.console, args);
    };
  }
  return noop;
}

function checkRepeatWrapper(func) {
  var lastMsg;
  return function(...args) {
    if (args.join(' ') === lastMsg) {
      return;
    }
    lastMsg = args.join(' ');
    func.apply(null, args);
  };
}

function exportLoggerFunctions(debugConfig, ...functions) {
  functions.forEach(function(type) {
    exportedLogger[type] = checkRepeatWrapper(function(){
      let logFn = hls&&hls.holaLog&&hls.holaLog[type] || debugConfig[type] || consolePrintFn(type);
      logFn.apply(null, arguments);
    });
  });
}

export var enableLogs = function(debugConfig, hlsObject) {
  if (debugConfig === true || typeof debugConfig === 'object') {
    hls = hlsObject;
    exportLoggerFunctions(debugConfig,
      // Remove out from list here to hard-disable a log-level
      //'trace',
      'debug',
      'log',
      'info',
      'warn',
      'error'
    );
    // Some browsers don't allow to use bind on console object anyway
    // fallback to default if needed
    try {
      exportedLogger.log();
    } catch (e) {
      exportedLogger = fakeLogger;
    }
  }
  else {
    exportedLogger = fakeLogger;
  }
};

export var logger = exportedLogger;
