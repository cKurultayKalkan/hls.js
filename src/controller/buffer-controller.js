/*
 * Buffer Controller
*/

import Event from '../events';
import EventHandler from '../event-handler';
import {logger} from '../utils/logger';
import {ErrorTypes, ErrorDetails} from '../errors';


class BufferController extends EventHandler {

  constructor(hls) {
    super(hls,
      Event.MEDIA_ATTACHING,
      Event.MEDIA_DETACHING,
      Event.BUFFER_RESET,
      Event.BUFFER_APPENDING,
      Event.BUFFER_CODECS,
      Event.BUFFER_EOS,
      Event.BUFFER_FLUSHING,
      Event.FRAG_PARSING_DATA,
      Event.FRAG_APPENDING,
      Event.LEVEL_UPDATED);

    // the value that we have set mediasource.duration to
    // (the actual duration may be tweaked slighly by the browser)
    this._msDuration = null;
    // the value that we want to set mediaSource.duration to
    this._levelDuration = null;

    // Source Buffer listeners
    this.onsbue = this.onSBUpdateEnd.bind(this);
    this.onsbe  = this.onSBUpdateError.bind(this);
    this.tracks = {};
  }

  destroy() {
    EventHandler.prototype.destroy.call(this);
  }

  onFragParsingData(data) {
    let type = data.type;
    let audioTrack = this.tracks.audio;

    // Adjusting `SourceBuffer.timestampOffset` (desired point in the timeline where the next frames should be appended)
    // in Chrome browser when we detect MPEG audio container and time delta between level PTS and `SourceBuffer.timestampOffset`
    // is greater than 100ms (this is enough to handle seek for VOD or level change for LIVE videos). At the time of change we issue
    // `SourceBuffer.abort()` and adjusting `SourceBuffer.timestampOffset` if `SourceBuffer.updating` is false or awaiting `updateend`
    // event if SB is in updating state.
    // More info here: https://github.com/dailymotion/hls.js/issues/332#issuecomment-257986486

    if (type === 'audio' && audioTrack && audioTrack.container === 'audio/mpeg') { // Chrome audio mp3 track
      let audioBuffer = this.sourceBuffer.audio;
      let delta = Math.abs(audioBuffer.timestampOffset - data.startPTS);

      // adjust timestamp offset if time delta is greater than 100ms
      if (delta > 0.1) {
        let updating = audioBuffer.updating;

        try {
          audioBuffer.abort();
        } catch (err) {
          updating = true;
          logger.warn('can not abort audio buffer: ' + err);
        }

        if (!updating) {
          logger.warn('change mpeg audio timestamp offset from ' + audioBuffer.timestampOffset + ' to ' + data.startPTS);
          audioBuffer.timestampOffset = data.startPTS;
        } else {
          this.audioTimestampOffset = data.startPTS;
        }
      }
    }
  }

  onMediaAttaching(data) {
    let media = this.media = data.media;
    if (media) {
      // setup the media source
      let ms = this.mediaSource = new MediaSource();
      //Media Source listeners
      this.onmso = this.onMediaSourceOpen.bind(this);
      this.onmse = this.onMediaSourceEnded.bind(this);
      this.onmsc = this.onMediaSourceClose.bind(this);
      ms.addEventListener('sourceopen', this.onmso);
      ms.addEventListener('sourceended', this.onmse);
      ms.addEventListener('sourceclose', this.onmsc);
      // link video and media Source
      let url = URL.createObjectURL(ms);
      logger.log(`set object url ${url}`);
      media.src = url;
      this.sbAppend = 0;
    }
  }

  onMediaDetaching() {
    logger.log('media source detaching');
    var ms = this.mediaSource;
    if (ms) {
      if (ms.readyState === 'open') {
        try {
          // endOfStream could trigger exception if any sourcebuffer is in updating state
          // we don't really care about checking sourcebuffer state here,
          // as we are anyway detaching the MediaSource
          // let's just avoid this exception to propagate
          ms.endOfStream();
        } catch(err) {
          logger.warn(`onMediaDetaching:${err.message} while calling endOfStream`);
        }
      }
      ms.removeEventListener('sourceopen', this.onmso);
      ms.removeEventListener('sourceended', this.onmse);
      ms.removeEventListener('sourceclose', this.onmsc);

      // Detach properly the MediaSource from the HTMLMediaElement as
      // suggested in https://github.com/w3c/media-source/issues/53.
      if (this.media) {
        this.media.removeAttribute('src');
        this.media.load();
      }

      this.mediaSource = null;
      this.media = null;
      this.pendingTracks = null;
      this.tracks = {};
      this.sourceBuffer = {};
      this.flushRange = [];
      this.segments = [];
      this.appended = 0;
    }
    this.onmso = this.onmse = this.onmsc = null;
    this.waitForAppended = false;
    this.hls.trigger(Event.MEDIA_DETACHED);
  }

  onMediaSourceOpen() {
    logger.log('media source opened');
    this.hls.trigger(Event.MEDIA_ATTACHED, { media : this.media });
    // once received, don't listen anymore to sourceopen event
    this.mediaSource.removeEventListener('sourceopen', this.onmso);
    // if any buffer codecs pending, treat it here.
    var pendingTracks = this.pendingTracks;
    if (pendingTracks) {
      this.onBufferCodecs(pendingTracks);
      this.pendingTracks = null;
      this.doAppending();
    }
  }

  onMediaSourceClose() {
    logger.log('media source closed');
  }

  onMediaSourceEnded() {
    logger.log('media source ended');
  }

  onFragAppending() {
    var segments = this.segments || [];
    if (!segments.length && !this.isSbUpdating()) {
      this.hls.trigger(Event.FRAG_APPENDED);
    } else {
      this.waitForAppended = true;
    }
  }

  isSbUpdating() {
    var sourceBuffer = this.sourceBuffer;
    if (!sourceBuffer) {
      return;
    }
    for (var type in sourceBuffer) {
      if (sourceBuffer[type].updating) {
        return true;
      }
    }
  }

  dump(video) {
    var str = '', b = video.buffered, len = b.length;
    for (var i=0; i<len; i++) {
      str += '['+b.start(i)+','+b.end(i)+']';
    }
    return str;
  }

  clear(video, keepSec) {
    var st, sb = this.sourceBuffer, end = video.currentTime - keepSec;
    var b = video.buffered;
    if (end<=0 || this.isSbUpdating() || !b.length) {
      return;
    }
    st = b.start(0);
    if (st<end) {
      logger.log(`video buffered: ${this.dump(this.media)} removing: [${st},${end}]`);
      for (var type in sb) {
        sb[type].remove(st, end);
      }
    }
  }

  onSBUpdateEnd(event) {
    // update timestampOffset
    if (this.audioTimestampOffset) {
      let audioBuffer = this.sourceBuffer.audio;
      if (audioBuffer && !audioBuffer.updating) {
        logger.warn('change mpeg audio timestamp offset from ' + audioBuffer.timestampOffset + ' to ' + this.audioTimestampOffset);
        audioBuffer.timestampOffset = this.audioTimestampOffset;
        delete this.audioTimestampOffset;
      }
    }

    if (this._needsFlush) {
      this.doFlush();
    }

    if (this._needsEos) {
      this.onBufferEos();
    }

    if (event){
      this.sbAppend--;
    }

    logger.log(`sb updateend ${event ? event.target===this.sourceBuffer.audio ? 'audio' : event.target===this.sourceBuffer.video ? 'video' : 'unknown sb' : 'unknown'} ${this.sbAppend}`);

    this.updateMediaElementDuration();

    this.doAppending();

    if (this.waitForAppended && !this.segments.length && !this.isSbUpdating()) {
      this.hls.trigger(Event.FRAG_APPENDED);
      this.waitForAppended = false;
    }
    let keep;
    if ((keep = this.hls.config.keepBuffered) && this.media) {
      try {
        this.clear(this.media, keep);
      } catch(err) {
        logger.log(err);
      }
    }
  }

  onSBUpdateError(event) {
    let err = this.lastSegment ? `last segment type:${this.lastSegment.type},size:${this.lastSegment.data.length})` : '';
    logger.error(`onSBUpdateError: sourceBuffer error:${event} ${err}`);
    this.lastSegment = undefined;
    this.printDump();
    // according to http://www.w3.org/TR/media-source/#sourcebuffer-append-error
    // this error might not always be fatal (it is fatal if decode error is set, in that case
    // it will be followed by a mediaElement error ...)
    this.hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_APPENDING_ERROR, fatal: false});
    // we don't need to do more than that, as accordin to the spec, updateend will be fired just after
  }

  onBufferReset() {
    var sourceBuffer = this.sourceBuffer, segments = this.segments || [];
    logger.log(`onBufferReset: pending segments:${segments.length}`);
    for(var type in sourceBuffer) {
      var sb = sourceBuffer[type];
      try {
        this.mediaSource.removeSourceBuffer(sb);
        sb.removeEventListener('updateend', this.onsbue);
        sb.removeEventListener('error', this.onsbe);
      } catch(err) {
      }
    }
    this.sourceBuffer = {};
    this.flushRange = [];
    this.appended = 0;
    this.segments = [];
    this.dumpSegments = undefined;
  }

  isTrackChanged(tracks) {
    let track, sb = this.sourceBuffer;
    if (sb.video && !tracks.video || !sb.video && sb.audio && tracks.video) {
      return true;
    }
    if (sb.audio && (track = tracks.audio)) {
      let prev = this.tracks.audio;
      let codec = track.levelCodec || track.codec;
      let isMp3 = track.container === 'audio/mpeg' || prev.container === 'audio/mpeg' || codec === 'mp3' || prev.codec === 'mp3';
      if ((track.container !== prev.container || prev.codec !== codec) && isMp3) {
        return true;
      }
    }
  }

  onBufferCodecs(tracks) {
    let mediaSource = this.mediaSource;

    // delay sourcebuffer creation if media source not opened yet
    if(!mediaSource || mediaSource.readyState !== 'open') {
      this.pendingTracks = tracks;
      return;
    }

    let sourceBuffer = this.sourceBuffer;

    if (this.isTrackChanged(tracks)) {
      let media = this.media;
      this.hls.detachMedia();
      this.hls.attachMedia(media);
      return;
    }

    for (let trackName in tracks) {
      if(!sourceBuffer[trackName]) {
        let track = tracks[trackName];
        // use levelCodec as first priority
        let codec = track.levelCodec || track.codec;
        let mimeType = `${track.container};codecs=${codec}`;
        logger.log(`creating sourceBuffer with mimeType:${mimeType}`);
        try {
          let sb = sourceBuffer[trackName] = mediaSource.addSourceBuffer(mimeType);
          sb.addEventListener('updateend', this.onsbue);
          sb.addEventListener('error', this.onsbe);
          this.tracks[trackName] = {codec: codec, container: track.container};
        } catch(err) {
          logger.error(`error while trying to add sourceBuffer:${err.message}`);
          this.hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_ADD_CODEC_ERROR, fatal: false, err: err, mimeType : mimeType});
        }
      }
    }
  }

  onBufferAppending(data) {
    this.segments = this.segments||[];
    this.segments.push(data);
    this.doAppending();
  }

  onBufferAppendFail(data) {
    let err = this.lastSegment ? `last segment type:${this.lastSegment.type},size:${this.lastSegment.data.length})` : '';
    logger.error(`onBufferAppendFail:sourceBuffer error:${data.event} ${err}`);
    this.lastSegment = undefined;
    this.printDump();
    // according to http://www.w3.org/TR/media-source/#sourcebuffer-append-error
    // this error might not always be fatal (it is fatal if decode error is set, in that case
    // it will be followed by a mediaElement error ...)
    this.hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.BUFFER_APPENDING_ERROR, fatal: false, frag: this.fragCurrent});
  }

  onBufferEos() {
    var sb = this.sourceBuffer, mediaSource = this.mediaSource;
    if (!mediaSource || mediaSource.readyState !== 'open') {
      return;
    }
    if (!((sb.audio && sb.audio.updating) || (sb.video && sb.video.updating))) {
      logger.log('all media data available, signal endOfStream() to MediaSource and stop loading fragment');
      logger.log(`append/updateend count ${this.sbAppend}`);
      //Notify the media element that it now has all of the media data
      mediaSource.endOfStream();
      this._needsEos = false;
    } else {
      this._needsEos = true;
    }
  }

  onBufferFlushing(data) {
    this.flushRange.push({start: data.startOffset, end: data.endOffset});
    // attempt flush immediatly
    this.flushBufferCounter = 0;
    this.doFlush();
  }

  onLevelUpdated(event) {
    let details = event.details;
    if (details.fragments.length === 0) {
      return;
    }
    this._levelDuration = details.totalduration + details.fragments[0].start;
    this.updateMediaElementDuration();
  }

  // https://github.com/dailymotion/hls.js/issues/355
  updateMediaElementDuration() {
    let media = this.media,
        mediaSource = this.mediaSource,
        levelDuration = this._levelDuration;
    if (levelDuration === null || !media || !mediaSource || media.readyState === 0 || mediaSource.readyState !== 'open') {
      return;
    }
    for (let i = 0; i < mediaSource.sourceBuffers.length; i++) {
      if (mediaSource.sourceBuffers[i].updating) {
        // can't set duration whilst a buffer is updating
        return;
      }
    }
    if (this._msDuration === null) {
      // initialise to the value that the media source is reporting
      this._msDuration = mediaSource.duration;
    }
    let duration = media.duration;
    // levelDuration was the last value we set.
    // not using mediaSource.duration as the browser may tweak this value
    // only update mediasource duration if its value increase, this is to avoid
    // flushing already buffered portion when switching between quality level
    if ((levelDuration > this._msDuration && levelDuration > duration) || (duration === Infinity || isNaN(duration) )) {
      logger.log(`Updating mediasource duration to ${levelDuration.toFixed(3)}`);
      this._msDuration = mediaSource.duration = levelDuration;
    }
  }

  doFlush() {
    // loop through all buffer ranges to flush
    while(this.flushRange.length) {
      var range = this.flushRange[0];
      // flushBuffer will abort any buffer append in progress and flush Audio/Video Buffer
      if (this.flushBuffer(range.start, range.end)) {
        // range flushed, remove from flush array
        this.flushRange.shift();
        this.flushBufferCounter = 0;
      } else {
        this._needsFlush = true;
        // avoid looping, wait for SB update end to retrigger a flush
        return;
      }
    }
    if (this.flushRange.length === 0) {
      // everything flushed
      this._needsFlush = false;

      // let's recompute this.appended, which is used to avoid flush looping
      var appended = 0;
      var sourceBuffer = this.sourceBuffer;
      for (var type in sourceBuffer) {
        appended += sourceBuffer[type].buffered.length;
      }
      this.appended = appended;
      this.hls.trigger(Event.BUFFER_FLUSHED);
    }
  }

  dumpSegment(segment) {
    let i, len = segment.data.length;
    let info = `queue:${this.segments.length}type:${segment.type},size:${len},buf:[`;
    for (i = 0, len = Math.min(len, 10); i<len; i++) {
      if (i) {
        info += ',';
      }
      info += segment.data[i];
    }
    info += '..]';
    if (!this.dumpSegments) {
      this.dumpSegments = [info];
    } else {
      this.dumpSegments.push(info);
    }
    if (this.dumpSegments.length>10) {
      this.dumpSegments.shift();
    }
  }

  printDump() {
    if (this.dumpSegments && this.dumpSegments.length) {
      logger.error(this.dumpSegments.join('|'));
    }
  }

  doAppending() {
    var hls = this.hls, sourceBuffer = this.sourceBuffer, segments = this.segments;
    if (sourceBuffer && Object.keys(sourceBuffer).length) {
      if (!this.media) {
        return;
      }
      if (this.media.error) {
        this.segments = [];
        logger.error('trying to append although a media error occured, flush segment and abort');
        return;
      }
      if (this.isSbUpdating()) {
        logger.log('sb update in progress');
        return;
      }
      if (segments.length) {
        var segment = segments.shift();
        this.dumpSegment(segment);
        try {
          logger.log(`appending ${segment.type} SB, size:${segment.data.length} ${this.sbAppend}`);
          if(sourceBuffer[segment.type]) {
            this.lastSegment = segment;
            sourceBuffer[segment.type].appendBuffer(segment.data);
            this.appendError = 0;
            this.appended++;
            this.sbAppend++;
          } else {
            // in case we don't have any source buffer matching with this segment type,
            // it means that Mediasource fails to create sourcebuffer
            // discard this segment, and trigger update end
            this.onSBUpdateEnd();
          }
        } catch(err) {
          // in case any error occured while appending, put back segment in segments table
          logger.error(`error while trying to append buffer: ${err.message}`);
          segments.unshift(segment);
          var event = {type: ErrorTypes.MEDIA_ERROR};
          if(err.code !== 22) {
            if (this.appendError) {
              this.appendError++;
            } else {
              this.appendError = 1;
            }
            event.details = ErrorDetails.BUFFER_APPEND_ERROR;
            event.frag = this.fragCurrent;
            event.reason = `${err.message} (type:${segment.type},size:${segment.data.length})`;
            /* with UHD content, we could get loop of quota exceeded error until
              browser is able to evict some data from sourcebuffer. retrying help recovering this
            */
            if (this.appendError > hls.config.appendErrorMaxRetry) {
              logger.log(`fail ${hls.config.appendErrorMaxRetry} times to append segment in sourceBuffer`);
              this.segments = [];
              event.fatal = true;
              hls.trigger(Event.ERROR, event);
              return;
            } else {
              event.fatal = false;
              hls.trigger(Event.ERROR, event);
            }
          } else {
            // QuotaExceededError: http://www.w3.org/TR/html5/infrastructure.html#quotaexceedederror
            // let's stop appending any segments, and report BUFFER_FULL_ERROR error
            this.segments = [];
            event.details = ErrorDetails.BUFFER_FULL_ERROR;
            hls.trigger(Event.ERROR,event);
          }
        }
      }
    }
  }

  /*
    flush specified buffered range,
    return true once range has been flushed.
    as sourceBuffer.remove() is asynchronous, flushBuffer will be retriggered on sourceBuffer update end
  */
  flushBuffer(startOffset, endOffset) {
    var sb, i, bufStart, bufEnd, flushStart, flushEnd;
    logger.log(`flushBuffer,pos/start/end: ${this.media.currentTime}/${startOffset}/${endOffset}`);
    // safeguard to avoid infinite looping : don't try to flush more than the nb of appended segments
    if (this.flushBufferCounter < this.appended && this.sourceBuffer) {
      for (var type in this.sourceBuffer) {
        sb = this.sourceBuffer[type];
        if (!sb.updating) {
          for (i = 0; i < sb.buffered.length; i++) {
            bufStart = sb.buffered.start(i);
            bufEnd = sb.buffered.end(i);
            // workaround firefox not able to properly flush multiple buffered range.
            if (this.hls.config.browser.isFirefox && endOffset === Number.POSITIVE_INFINITY) {
              flushStart = startOffset;
              flushEnd = endOffset;
            } else {
              flushStart = Math.max(bufStart, startOffset);
              flushEnd = Math.min(bufEnd, endOffset);
            }
            /* sometimes sourcebuffer.remove() does not flush
               the exact expected time range.
               to avoid rounding issues/infinite loop,
               only flush buffer range of length greater than 500ms.
            */
            if (Math.min(flushEnd,bufEnd) - flushStart > 0.5 ) {
              this.flushBufferCounter++;
              logger.log(`flush ${type} [${flushStart},${flushEnd}], of [${bufStart},${bufEnd}], pos:${this.media.currentTime}`);
              sb.remove(flushStart, flushEnd);
              return false;
            }
          }
        } else {
          //logger.log('abort ' + type + ' append in progress');
          // this will abort any appending in progress
          //sb.abort();
          logger.warn('cannot flush, sb updating in progress');
          return false;
        }
      }
    } else {
      logger.warn('abort flushing too many retries');
    }
    logger.log('buffer flushed');
    // everything flushed !
    return true;
  }
}

export default BufferController;
