(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/h264-converter/dist/util/bit-stream.js
  var require_bit_stream = __commonJS({
    "node_modules/h264-converter/dist/util/bit-stream.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var BitStream = function() {
        function BitStream2(data) {
          this.data = data;
          this.index = 0;
          this.bitLength = data.byteLength * 8;
        }
        Object.defineProperty(BitStream2.prototype, "bitsAvailable", {
          get: function() {
            return this.bitLength - this.index;
          },
          enumerable: true,
          configurable: true
        });
        BitStream2.prototype.skipBits = function(size) {
          if (this.bitsAvailable < size) {
            throw new Error("no bytes available");
          }
          this.index += size;
        };
        BitStream2.prototype.readBits = function(size) {
          var result = this.getBits(size, this.index);
          return result;
        };
        BitStream2.prototype.getBits = function(size, offsetBits, moveIndex) {
          if (moveIndex === void 0) {
            moveIndex = true;
          }
          if (this.bitsAvailable < size) {
            throw new Error("no bytes available");
          }
          var offset = offsetBits % 8;
          var byte = this.data[offsetBits / 8 | 0] & 255 >>> offset;
          var bits = 8 - offset;
          if (bits >= size) {
            if (moveIndex) {
              this.index += size;
            }
            return byte >> bits - size;
          } else {
            if (moveIndex) {
              this.index += bits;
            }
            var nextSize = size - bits;
            return byte << nextSize | this.getBits(nextSize, offsetBits + bits, moveIndex);
          }
        };
        BitStream2.prototype.skipLZ = function() {
          var leadingZeroCount;
          for (leadingZeroCount = 0; leadingZeroCount < this.bitLength - this.index; ++leadingZeroCount) {
            if (0 !== this.getBits(1, this.index + leadingZeroCount, false)) {
              this.index += leadingZeroCount;
              return leadingZeroCount;
            }
          }
          return leadingZeroCount;
        };
        BitStream2.prototype.skipUEG = function() {
          this.skipBits(1 + this.skipLZ());
        };
        BitStream2.prototype.skipEG = function() {
          this.skipBits(1 + this.skipLZ());
        };
        BitStream2.prototype.readUEG = function() {
          var prefix = this.skipLZ();
          return this.readBits(prefix + 1) - 1;
        };
        BitStream2.prototype.readEG = function() {
          var value = this.readUEG();
          if (1 & value) {
            return 1 + value >>> 1;
          } else {
            return -1 * (value >>> 1);
          }
        };
        BitStream2.prototype.readBoolean = function() {
          return 1 === this.readBits(1);
        };
        BitStream2.prototype.readUByte = function() {
          return this.readBits(8);
        };
        BitStream2.prototype.readUShort = function() {
          return this.readBits(16);
        };
        BitStream2.prototype.readUInt = function() {
          return this.readBits(32);
        };
        return BitStream2;
      }();
      exports.default = BitStream;
    }
  });

  // node_modules/h264-converter/dist/util/debug.js
  var require_debug = __commonJS({
    "node_modules/h264-converter/dist/util/debug.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var mLogger;
      var mErrorLogger;
      function setLogger2(logger, errorLogger) {
        mLogger = logger;
        mErrorLogger = errorLogger != null ? errorLogger : logger;
      }
      exports.setLogger = setLogger2;
      function isEnable() {
        return mLogger != null;
      }
      exports.isEnable = isEnable;
      function log2(message) {
        var optionalParams = [];
        for (var _i = 1; _i < arguments.length; _i++) {
          optionalParams[_i - 1] = arguments[_i];
        }
        if (mLogger) {
          mLogger.apply(void 0, [message].concat(optionalParams));
        }
      }
      exports.log = log2;
      function error(message) {
        var optionalParams = [];
        for (var _i = 1; _i < arguments.length; _i++) {
          optionalParams[_i - 1] = arguments[_i];
        }
        if (mErrorLogger) {
          mErrorLogger.apply(void 0, [message].concat(optionalParams));
        }
      }
      exports.error = error;
    }
  });

  // node_modules/h264-converter/dist/util/NALU.js
  var require_NALU = __commonJS({
    "node_modules/h264-converter/dist/util/NALU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var NALU = function() {
        function NALU2(data) {
          this.data = data;
          this.nri = (data[0] & 96) >> 5;
          this.ntype = data[0] & 31;
        }
        Object.defineProperty(NALU2, "NDR", {
          get: function() {
            return 1;
          },
          enumerable: true,
          configurable: true
        });
        Object.defineProperty(NALU2, "IDR", {
          get: function() {
            return 5;
          },
          enumerable: true,
          configurable: true
        });
        Object.defineProperty(NALU2, "SEI", {
          get: function() {
            return 6;
          },
          enumerable: true,
          configurable: true
        });
        Object.defineProperty(NALU2, "SPS", {
          get: function() {
            return 7;
          },
          enumerable: true,
          configurable: true
        });
        Object.defineProperty(NALU2, "PPS", {
          get: function() {
            return 8;
          },
          enumerable: true,
          configurable: true
        });
        Object.defineProperty(NALU2, "TYPES", {
          get: function() {
            var _a;
            return _a = {}, _a[NALU2.IDR] = "IDR", _a[NALU2.SEI] = "SEI", _a[NALU2.SPS] = "SPS", _a[NALU2.PPS] = "PPS", _a[NALU2.NDR] = "NDR", _a;
          },
          enumerable: true,
          configurable: true
        });
        NALU2.type = function(nalu) {
          if (nalu.ntype in NALU2.TYPES) {
            return NALU2.TYPES[nalu.ntype];
          } else {
            return "UNKNOWN";
          }
        };
        NALU2.prototype.type = function() {
          return this.ntype;
        };
        NALU2.prototype.isKeyframe = function() {
          return this.ntype === NALU2.IDR;
        };
        NALU2.prototype.getSize = function() {
          return 4 + this.data.byteLength;
        };
        NALU2.prototype.getData = function() {
          var result = new Uint8Array(this.getSize());
          var view = new DataView(result.buffer);
          view.setUint32(0, this.getSize() - 4);
          result.set(this.data, 4);
          return result;
        };
        return NALU2;
      }();
      exports.default = NALU;
    }
  });

  // node_modules/h264-converter/dist/h264-parser.js
  var require_h264_parser = __commonJS({
    "node_modules/h264-converter/dist/h264-parser.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var bit_stream_1 = require_bit_stream();
      var debug = require_debug();
      var NALU_1 = require_NALU();
      var H264Parser = function() {
        function H264Parser2(remuxer) {
          this.remuxer = remuxer;
          this.track = remuxer.mp4track;
        }
        H264Parser2.prototype.parseSEI = function(sei) {
          var messages = H264Parser2.readSEI(sei);
          for (var _i = 0, messages_1 = messages; _i < messages_1.length; _i++) {
            var m = messages_1[_i];
            switch (m.type) {
              case 0:
                this.track.seiBuffering = true;
                break;
              case 5:
                return true;
              default:
                break;
            }
          }
          return false;
        };
        H264Parser2.prototype.parseSPS = function(sps) {
          var config = H264Parser2.readSPS(sps);
          this.track.width = config.width;
          this.track.height = config.height;
          this.track.sps = [sps];
          this.track.codec = "avc1.";
          var codecArray = new DataView(sps.buffer, sps.byteOffset + 1, 4);
          for (var i = 0; i < 3; ++i) {
            var h = codecArray.getUint8(i).toString(16);
            if (h.length < 2) {
              h = "0" + h;
            }
            this.track.codec += h;
          }
        };
        H264Parser2.prototype.parsePPS = function(pps) {
          this.track.pps = [pps];
        };
        H264Parser2.prototype.parseNAL = function(unit) {
          if (!unit) {
            return false;
          }
          var push = false;
          switch (unit.type()) {
            case NALU_1.default.NDR:
            case NALU_1.default.IDR:
              push = true;
              break;
            case NALU_1.default.SEI:
              push = this.parseSEI(unit.getData().subarray(4));
              break;
            case NALU_1.default.SPS:
              this.parseSPS(unit.getData().subarray(4));
              debug.log(" Found SPS type NALU frame.");
              if (!this.remuxer.readyToDecode && this.track.pps.length > 0 && this.track.sps.length > 0) {
                this.remuxer.readyToDecode = true;
              }
              break;
            case NALU_1.default.PPS:
              this.parsePPS(unit.getData().subarray(4));
              debug.log(" Found PPS type NALU frame.");
              if (!this.remuxer.readyToDecode && this.track.pps.length > 0 && this.track.sps.length > 0) {
                this.remuxer.readyToDecode = true;
              }
              break;
            default:
              debug.log(" Found Unknown type NALU frame. type=" + unit.type());
              break;
          }
          return push;
        };
        H264Parser2.skipScalingList = function(decoder, count) {
          var lastScale = 8;
          var nextScale = 8;
          for (var j = 0; j < count; j++) {
            if (nextScale !== 0) {
              var deltaScale = decoder.readEG();
              nextScale = (lastScale + deltaScale + 256) % 256;
            }
            lastScale = nextScale === 0 ? lastScale : nextScale;
          }
        };
        H264Parser2.readSPS = function(data) {
          var _a = this.parseSPS(data), pic_width_in_mbs_minus1 = _a.pic_width_in_mbs_minus1, frame_crop_left_offset = _a.frame_crop_left_offset, frame_crop_right_offset = _a.frame_crop_right_offset, frame_mbs_only_flag = _a.frame_mbs_only_flag, pic_height_in_map_units_minus1 = _a.pic_height_in_map_units_minus1, frame_crop_top_offset = _a.frame_crop_top_offset, frame_crop_bottom_offset = _a.frame_crop_bottom_offset, sar = _a.sar;
          var sarScale = sar[0] / sar[1];
          return {
            width: Math.ceil(((pic_width_in_mbs_minus1 + 1) * 16 - frame_crop_left_offset * 2 - frame_crop_right_offset * 2) * sarScale),
            height: (2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16 - (frame_mbs_only_flag ? 2 : 4) * (frame_crop_top_offset + frame_crop_bottom_offset)
          };
        };
        H264Parser2.parseSPS = function(data) {
          var decoder = new bit_stream_1.default(data);
          var frame_crop_left_offset = 0;
          var frame_crop_right_offset = 0;
          var frame_crop_top_offset = 0;
          var frame_crop_bottom_offset = 0;
          decoder.readUByte();
          var profile_idc = decoder.readUByte();
          var constraint_set_flags = decoder.readUByte();
          var level_idc = decoder.readBits(8);
          var seq_parameter_set_id = decoder.readUEG();
          if (profile_idc === 100 || profile_idc === 110 || profile_idc === 122 || profile_idc === 244 || profile_idc === 44 || profile_idc === 83 || profile_idc === 86 || profile_idc === 118 || profile_idc === 128 || profile_idc === 138 || profile_idc === 139 || profile_idc === 134) {
            var chromaFormatIdc = decoder.readUEG();
            if (chromaFormatIdc === 3) {
              decoder.skipBits(1);
            }
            decoder.skipUEG();
            decoder.skipUEG();
            decoder.skipBits(1);
            if (decoder.readBoolean()) {
              var scalingListCount = chromaFormatIdc !== 3 ? 8 : 12;
              for (var i = 0; i < scalingListCount; ++i) {
                if (decoder.readBoolean()) {
                  if (i < 6) {
                    H264Parser2.skipScalingList(decoder, 16);
                  } else {
                    H264Parser2.skipScalingList(decoder, 64);
                  }
                }
              }
            }
          }
          decoder.skipUEG();
          var picOrderCntType = decoder.readUEG();
          if (picOrderCntType === 0) {
            decoder.readUEG();
          } else if (picOrderCntType === 1) {
            decoder.skipBits(1);
            decoder.skipEG();
            decoder.skipEG();
            var numRefFramesInPicOrderCntCycle = decoder.readUEG();
            for (var i = 0; i < numRefFramesInPicOrderCntCycle; ++i) {
              decoder.skipEG();
            }
          }
          decoder.skipUEG();
          decoder.skipBits(1);
          var pic_width_in_mbs_minus1 = decoder.readUEG();
          var pic_height_in_map_units_minus1 = decoder.readUEG();
          var frame_mbs_only_flag = decoder.readBits(1);
          if (frame_mbs_only_flag === 0) {
            decoder.skipBits(1);
          }
          decoder.skipBits(1);
          if (decoder.readBoolean()) {
            frame_crop_left_offset = decoder.readUEG();
            frame_crop_right_offset = decoder.readUEG();
            frame_crop_top_offset = decoder.readUEG();
            frame_crop_bottom_offset = decoder.readUEG();
          }
          var vui_parameters_present_flag = decoder.readBoolean();
          var aspect_ratio_info_present_flag = false;
          var sar = [1, 1];
          if (vui_parameters_present_flag) {
            aspect_ratio_info_present_flag = decoder.readBoolean();
            if (aspect_ratio_info_present_flag) {
              var aspectRatioIdc = decoder.readUByte();
              switch (aspectRatioIdc) {
                case 1:
                  sar = [1, 1];
                  break;
                case 2:
                  sar = [12, 11];
                  break;
                case 3:
                  sar = [10, 11];
                  break;
                case 4:
                  sar = [16, 11];
                  break;
                case 5:
                  sar = [40, 33];
                  break;
                case 6:
                  sar = [24, 11];
                  break;
                case 7:
                  sar = [20, 11];
                  break;
                case 8:
                  sar = [32, 11];
                  break;
                case 9:
                  sar = [80, 33];
                  break;
                case 10:
                  sar = [18, 11];
                  break;
                case 11:
                  sar = [15, 11];
                  break;
                case 12:
                  sar = [64, 33];
                  break;
                case 13:
                  sar = [160, 99];
                  break;
                case 14:
                  sar = [4, 3];
                  break;
                case 15:
                  sar = [3, 2];
                  break;
                case 16:
                  sar = [2, 1];
                  break;
                case 255: {
                  sar = [decoder.readUByte() << 8 | decoder.readUByte(), decoder.readUByte() << 8 | decoder.readUByte()];
                  break;
                }
                default: {
                  debug.error("  H264: Unknown aspectRatioIdc=" + aspectRatioIdc);
                }
              }
            }
            if (decoder.readBoolean()) {
              decoder.skipBits(1);
            }
            if (decoder.readBoolean()) {
              decoder.skipBits(4);
              if (decoder.readBoolean()) {
                decoder.skipBits(24);
              }
            }
            if (decoder.readBoolean()) {
              decoder.skipUEG();
              decoder.skipUEG();
            }
            if (decoder.readBoolean()) {
              if (decoder.bitsAvailable > 64) {
                var unitsInTick = decoder.readUInt();
                var timeScale = decoder.readUInt();
                var fixedFrameRate = decoder.readBoolean();
                var frameDuration = timeScale / (2 * unitsInTick);
                debug.log("timescale: " + timeScale + "; unitsInTick: " + unitsInTick + "; " + ("fixedFramerate: " + fixedFrameRate + "; avgFrameDuration: " + frameDuration));
              } else {
                debug.log("Truncated VUI (" + decoder.bitsAvailable + ")");
              }
            }
          }
          return {
            profile_idc,
            constraint_set_flags,
            level_idc,
            seq_parameter_set_id,
            pic_width_in_mbs_minus1,
            pic_height_in_map_units_minus1,
            frame_mbs_only_flag,
            frame_crop_left_offset,
            frame_crop_right_offset,
            frame_crop_top_offset,
            frame_crop_bottom_offset,
            sar
          };
        };
        H264Parser2.readSEI = function(data) {
          var decoder = new bit_stream_1.default(data);
          decoder.skipBits(8);
          var result = [];
          while (decoder.bitsAvailable > 3 * 8) {
            result.push(this.readSEIMessage(decoder));
          }
          return result;
        };
        H264Parser2.readSEIMessage = function(decoder) {
          function get() {
            var result = 0;
            while (true) {
              var value = decoder.readUByte();
              result += value;
              if (value !== 255) {
                break;
              }
            }
            return result;
          }
          var payloadType = get();
          var payloadSize = get();
          return this.readSEIPayload(decoder, payloadType, payloadSize);
        };
        H264Parser2.readSEIPayload = function(decoder, type, size) {
          var result;
          switch (type) {
            default:
              result = { type };
              decoder.skipBits(size * 8);
          }
          decoder.skipBits(decoder.bitsAvailable % 8);
          return result;
        };
        return H264Parser2;
      }();
      exports.default = H264Parser;
    }
  });

  // node_modules/h264-converter/dist/h264-remuxer.js
  var require_h264_remuxer = __commonJS({
    "node_modules/h264-converter/dist/h264-remuxer.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var h264_parser_1 = require_h264_parser();
      var debug = require_debug();
      var NALU_1 = require_NALU();
      var trackId = 1;
      var H264Remuxer = function() {
        function H264Remuxer2(fps, framePerFragment, timescale) {
          this.fps = fps;
          this.framePerFragment = framePerFragment;
          this.timescale = timescale;
          this.readyToDecode = false;
          this.totalDTS = 0;
          this.stepDTS = Math.round(this.timescale / this.fps);
          this.frameCount = 0;
          this.seq = 1;
          this.mp4track = {
            id: H264Remuxer2.getTrackID(),
            type: "video",
            len: 0,
            codec: "",
            sps: [],
            pps: [],
            seiBuffering: false,
            width: 0,
            height: 0,
            timescale,
            duration: timescale,
            samples: [],
            isKeyFrame: true
          };
          this.unitSamples = [[]];
          this.parser = new h264_parser_1.default(this);
        }
        H264Remuxer2.getTrackID = function() {
          return trackId++;
        };
        Object.defineProperty(H264Remuxer2.prototype, "seqNum", {
          get: function() {
            return this.seq;
          },
          enumerable: true,
          configurable: true
        });
        H264Remuxer2.prototype.remux = function(nalu) {
          if (this.mp4track.seiBuffering && nalu.type() === NALU_1.default.SEI) {
            return this.createNextFrame();
          }
          if (this.parser.parseNAL(nalu)) {
            this.unitSamples[this.unitSamples.length - 1].push(nalu);
            this.mp4track.len += nalu.getSize();
            this.mp4track.isKeyFrame = nalu.isKeyframe();
          }
          if (!this.mp4track.seiBuffering && (nalu.type() === NALU_1.default.IDR || nalu.type() === NALU_1.default.NDR)) {
            return this.createNextFrame();
          }
          return;
        };
        H264Remuxer2.prototype.createNextFrame = function() {
          if (this.mp4track.len > 0) {
            this.frameCount++;
            if (this.frameCount % this.framePerFragment === 0) {
              var fragment = this.getFragment();
              if (fragment) {
                var dts = this.totalDTS;
                this.totalDTS = this.stepDTS * this.frameCount;
                return [dts, fragment];
              } else {
                debug.log("No mp4 sample data.");
              }
            }
            this.unitSamples.push([]);
          }
          return;
        };
        H264Remuxer2.prototype.flush = function() {
          this.seq++;
          this.mp4track.len = 0;
          this.mp4track.samples = [];
          this.mp4track.isKeyFrame = false;
          this.unitSamples = [[]];
        };
        H264Remuxer2.prototype.getFragment = function() {
          if (!this.checkReadyToDecode()) {
            return void 0;
          }
          var payload = new Uint8Array(this.mp4track.len);
          this.mp4track.samples = [];
          var offset = 0;
          for (var i = 0, len = this.unitSamples.length; i < len; i++) {
            var units = this.unitSamples[i];
            if (units.length === 0) {
              continue;
            }
            var mp4Sample = {
              size: 0,
              cts: this.stepDTS * i
            };
            for (var _i = 0, units_1 = units; _i < units_1.length; _i++) {
              var unit = units_1[_i];
              mp4Sample.size += unit.getSize();
              payload.set(unit.getData(), offset);
              offset += unit.getSize();
            }
            this.mp4track.samples.push(mp4Sample);
          }
          if (offset === 0) {
            return void 0;
          }
          return payload;
        };
        H264Remuxer2.prototype.checkReadyToDecode = function() {
          if (!this.readyToDecode || this.unitSamples.filter(function(array) {
            return array.length > 0;
          }).length === 0) {
            debug.log("Not ready to decode! readyToDecode(" + this.readyToDecode + ") is false or units is empty.");
            return false;
          }
          return true;
        };
        return H264Remuxer2;
      }();
      exports.default = H264Remuxer;
    }
  });

  // node_modules/h264-converter/dist/mp4-generator.js
  var require_mp4_generator = __commonJS({
    "node_modules/h264-converter/dist/mp4-generator.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var MP4 = function() {
        function MP42() {
        }
        MP42.init = function() {
          MP42.initalized = true;
          MP42.types = {
            avc1: [],
            avcC: [],
            btrt: [],
            dinf: [],
            dref: [],
            esds: [],
            ftyp: [],
            hdlr: [],
            mdat: [],
            mdhd: [],
            mdia: [],
            mfhd: [],
            minf: [],
            moof: [],
            moov: [],
            mp4a: [],
            mvex: [],
            mvhd: [],
            sdtp: [],
            stbl: [],
            stco: [],
            stsc: [],
            stsd: [],
            stsz: [],
            stts: [],
            styp: [],
            tfdt: [],
            tfhd: [],
            traf: [],
            trak: [],
            trun: [],
            trep: [],
            trex: [],
            tkhd: [],
            vmhd: [],
            smhd: []
          };
          for (var type in MP42.types) {
            if (MP42.types.hasOwnProperty(type)) {
              MP42.types[type] = [
                type.charCodeAt(0),
                type.charCodeAt(1),
                type.charCodeAt(2),
                type.charCodeAt(3)
              ];
            }
          }
          var hdlr = new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            118,
            105,
            100,
            101,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            86,
            105,
            100,
            101,
            111,
            72,
            97,
            110,
            100,
            108,
            101,
            114,
            0
          ]);
          var dref = new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            12,
            117,
            114,
            108,
            32,
            0,
            0,
            0,
            1
          ]);
          var stco = new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0
          ]);
          MP42.STTS = MP42.STSC = MP42.STCO = stco;
          MP42.STSZ = new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0
          ]);
          MP42.VMHD = new Uint8Array([
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0
          ]);
          MP42.SMHD = new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0
          ]);
          MP42.STSD = new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1
          ]);
          MP42.FTYP = MP42.box(MP42.types.ftyp, new Uint8Array([
            105,
            115,
            111,
            53,
            0,
            0,
            0,
            1,
            97,
            118,
            99,
            49,
            105,
            115,
            111,
            53,
            100,
            97,
            115,
            104
          ]));
          MP42.STYP = MP42.box(MP42.types.styp, new Uint8Array([
            109,
            115,
            100,
            104,
            0,
            0,
            0,
            0,
            109,
            115,
            100,
            104,
            109,
            115,
            105,
            120
          ]));
          MP42.DINF = MP42.box(MP42.types.dinf, MP42.box(MP42.types.dref, dref));
          MP42.HDLR = MP42.box(MP42.types.hdlr, hdlr);
        };
        MP42.box = function(type) {
          var payload = [];
          for (var _i = 1; _i < arguments.length; _i++) {
            payload[_i - 1] = arguments[_i];
          }
          var size = 8;
          for (var _a = 0, payload_1 = payload; _a < payload_1.length; _a++) {
            var p = payload_1[_a];
            size += p.byteLength;
          }
          var result = new Uint8Array(size);
          result[0] = size >> 24 & 255;
          result[1] = size >> 16 & 255;
          result[2] = size >> 8 & 255;
          result[3] = size & 255;
          result.set(type, 4);
          size = 8;
          for (var _b = 0, payload_2 = payload; _b < payload_2.length; _b++) {
            var box = payload_2[_b];
            result.set(box, size);
            size += box.byteLength;
          }
          return result;
        };
        MP42.mdat = function(data) {
          return MP42.box(MP42.types.mdat, data);
        };
        MP42.mdhd = function(timescale) {
          return MP42.box(MP42.types.mdhd, new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            2,
            timescale >> 24 & 255,
            timescale >> 16 & 255,
            timescale >> 8 & 255,
            timescale & 255,
            0,
            0,
            0,
            0,
            85,
            196,
            0,
            0
          ]));
        };
        MP42.mdia = function(track) {
          return MP42.box(MP42.types.mdia, MP42.mdhd(track.timescale), MP42.HDLR, MP42.minf(track));
        };
        MP42.mfhd = function(sequenceNumber) {
          return MP42.box(MP42.types.mfhd, new Uint8Array([
            0,
            0,
            0,
            0,
            sequenceNumber >> 24,
            sequenceNumber >> 16 & 255,
            sequenceNumber >> 8 & 255,
            sequenceNumber & 255
          ]));
        };
        MP42.minf = function(track) {
          return MP42.box(MP42.types.minf, MP42.box(MP42.types.vmhd, MP42.VMHD), MP42.DINF, MP42.stbl(track));
        };
        MP42.moof = function(sn, baseMediaDecodeTime, track) {
          return MP42.box(MP42.types.moof, MP42.mfhd(sn), MP42.traf(track, baseMediaDecodeTime));
        };
        MP42.moov = function(tracks, duration, timescale) {
          var boxes = [];
          for (var _i = 0, tracks_1 = tracks; _i < tracks_1.length; _i++) {
            var track = tracks_1[_i];
            boxes.push(MP42.trak(track));
          }
          return MP42.box.apply(MP42, [MP42.types.moov, MP42.mvhd(timescale, duration), MP42.mvex(tracks)].concat(boxes));
        };
        MP42.mvhd = function(timescale, duration) {
          var bytes = new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            2,
            timescale >> 24 & 255,
            timescale >> 16 & 255,
            timescale >> 8 & 255,
            timescale & 255,
            duration >> 24 & 255,
            duration >> 16 & 255,
            duration >> 8 & 255,
            duration & 255,
            0,
            1,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            64,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            2
          ]);
          return MP42.box(MP42.types.mvhd, bytes);
        };
        MP42.mvex = function(tracks) {
          var boxes = [];
          for (var _i = 0, tracks_2 = tracks; _i < tracks_2.length; _i++) {
            var track = tracks_2[_i];
            boxes.push(MP42.trex(track));
          }
          return MP42.box.apply(MP42, [MP42.types.mvex].concat(boxes, [MP42.trep()]));
        };
        MP42.trep = function() {
          return MP42.box(MP42.types.trep, new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1
          ]));
        };
        MP42.stbl = function(track) {
          return MP42.box(MP42.types.stbl, MP42.stsd(track), MP42.box(MP42.types.stts, MP42.STTS), MP42.box(MP42.types.stsc, MP42.STSC), MP42.box(MP42.types.stsz, MP42.STSZ), MP42.box(MP42.types.stco, MP42.STCO));
        };
        MP42.avc1 = function(track) {
          var sps = [];
          var pps = [];
          for (var _i = 0, _a = track.sps; _i < _a.length; _i++) {
            var data = _a[_i];
            var len = data.byteLength;
            sps.push(len >>> 8 & 255);
            sps.push(len & 255);
            sps = sps.concat(Array.prototype.slice.call(data));
          }
          for (var _b = 0, _c = track.pps; _b < _c.length; _b++) {
            var data = _c[_b];
            var len = data.byteLength;
            pps.push(len >>> 8 & 255);
            pps.push(len & 255);
            pps = pps.concat(Array.prototype.slice.call(data));
          }
          var avcc = MP42.box(MP42.types.avcC, new Uint8Array([
            1,
            sps[3],
            sps[4],
            sps[5],
            252 | 3,
            224 | track.sps.length
          ].concat(sps).concat([
            track.pps.length
          ]).concat(pps)));
          var width = track.width;
          var height = track.height;
          return MP42.box(MP42.types.avc1, new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            width >> 8 & 255,
            width & 255,
            height >> 8 & 255,
            height & 255,
            0,
            72,
            0,
            0,
            0,
            72,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            18,
            98,
            105,
            110,
            101,
            108,
            112,
            114,
            111,
            46,
            114,
            117,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            24,
            17,
            17
          ]), avcc, MP42.box(MP42.types.btrt, new Uint8Array([
            0,
            0,
            0,
            0,
            0,
            45,
            198,
            192,
            0,
            45,
            198,
            192
          ])));
        };
        MP42.stsd = function(track) {
          return MP42.box(MP42.types.stsd, MP42.STSD, MP42.avc1(track));
        };
        MP42.tkhd = function(track) {
          var id = track.id;
          var width = track.width;
          var height = track.height;
          return MP42.box(MP42.types.tkhd, new Uint8Array([
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            2,
            id >> 24 & 255,
            id >> 16 & 255,
            id >> 8 & 255,
            id & 255,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            track.type === "audio" ? 1 : 0,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            64,
            0,
            0,
            0,
            width >> 8 & 255,
            width & 255,
            0,
            0,
            height >> 8 & 255,
            height & 255,
            0,
            0
          ]));
        };
        MP42.traf = function(track, baseMediaDecodeTime) {
          var id = track.id;
          return MP42.box(MP42.types.traf, MP42.box(MP42.types.tfhd, new Uint8Array([
            0,
            2,
            0,
            0,
            id >> 24,
            id >> 16 & 255,
            id >> 8 & 255,
            id & 255
          ])), MP42.box(MP42.types.tfdt, new Uint8Array([
            0,
            0,
            0,
            0,
            baseMediaDecodeTime >> 24,
            baseMediaDecodeTime >> 16 & 255,
            baseMediaDecodeTime >> 8 & 255,
            baseMediaDecodeTime & 255
          ])), MP42.trun(track, 16 + 16 + 8 + 16 + 8 + 8));
        };
        MP42.trak = function(track) {
          track.duration = track.duration || 4294967295;
          return MP42.box(MP42.types.trak, MP42.tkhd(track), MP42.mdia(track));
        };
        MP42.trex = function(track) {
          var id = track.id;
          return MP42.box(MP42.types.trex, new Uint8Array([
            0,
            0,
            0,
            0,
            id >> 24,
            id >> 16 & 255,
            id >> 8 & 255,
            id & 255,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            60,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            0
          ]));
        };
        MP42.trun = function(track, offset) {
          var samples = track.samples || [];
          var len = samples.length;
          var additionalLen = track.isKeyFrame ? 4 : 0;
          var arraylen = 12 + additionalLen + 4 * len;
          var array = new Uint8Array(arraylen);
          offset += 8 + arraylen;
          array.set([
            0,
            0,
            2,
            track.isKeyFrame ? 5 : 1,
            len >>> 24 & 255,
            len >>> 16 & 255,
            len >>> 8 & 255,
            len & 255,
            offset >>> 24 & 255,
            offset >>> 16 & 255,
            offset >>> 8 & 255,
            offset & 255
          ], 0);
          if (track.isKeyFrame) {
            array.set([
              0,
              0,
              0,
              0
            ], 12);
          }
          for (var i = 0; i < len; i++) {
            var sample = samples[i];
            var size = sample.size;
            array.set([
              size >>> 24 & 255,
              size >>> 16 & 255,
              size >>> 8 & 255,
              size & 255
            ], 12 + additionalLen + 4 * i);
          }
          return MP42.box(MP42.types.trun, array);
        };
        MP42.initSegment = function(tracks, duration, timescale) {
          if (!MP42.initalized) {
            MP42.init();
          }
          var movie = MP42.moov(tracks, duration, timescale);
          var result = new Uint8Array(MP42.FTYP.byteLength + movie.byteLength);
          result.set(MP42.FTYP);
          result.set(movie, MP42.FTYP.byteLength);
          return result;
        };
        MP42.fragmentSegment = function(sn, baseMediaDecodeTime, track, payload) {
          var moof = MP42.moof(sn, baseMediaDecodeTime, track);
          var mdat = MP42.mdat(payload);
          var result = new Uint8Array(MP42.STYP.byteLength + moof.byteLength + mdat.byteLength);
          result.set(MP42.STYP);
          result.set(moof, MP42.STYP.byteLength);
          result.set(mdat, MP42.STYP.byteLength + moof.byteLength);
          return result;
        };
        MP42.types = {};
        MP42.initalized = false;
        return MP42;
      }();
      exports.default = MP4;
    }
  });

  // node_modules/h264-converter/dist/util/nalu-stream-buffer.js
  var require_nalu_stream_buffer = __commonJS({
    "node_modules/h264-converter/dist/util/nalu-stream-buffer.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var NALU_1 = require_NALU();
      var VideoStreamBuffer = function() {
        function VideoStreamBuffer2() {
        }
        VideoStreamBuffer2.prototype.clear = function() {
          this.buffer = void 0;
        };
        VideoStreamBuffer2.prototype.append = function(value) {
          var nextNalHeader = function(b) {
            var i = 3;
            return function() {
              var count = 0;
              for (; i < b.length; i++) {
                switch (b[i]) {
                  case 0:
                    count++;
                    break;
                  case 1:
                    if (count === 3) {
                      return i - 3;
                    }
                  default:
                    count = 0;
                }
              }
              return;
            };
          };
          var result = [];
          var buffer;
          if (this.buffer) {
            if (value[3] === 1 && value[2] === 0 && value[1] === 0 && value[0] === 0) {
              result.push(new NALU_1.default(this.buffer.subarray(4)));
              buffer = Uint8Array.from(value);
            }
          }
          if (buffer == null) {
            buffer = this.mergeBuffer(value);
          }
          var lastIndex = 0;
          var f = nextNalHeader(buffer);
          for (var index = f(); index != null; index = f()) {
            result.push(new NALU_1.default(buffer.subarray(lastIndex + 4, index)));
            lastIndex = index;
          }
          this.buffer = buffer.subarray(lastIndex);
          return result;
        };
        VideoStreamBuffer2.prototype.mergeBuffer = function(value) {
          if (this.buffer == null) {
            return Uint8Array.from(value);
          } else {
            var newBuffer = new Uint8Array(this.buffer.byteLength + value.length);
            if (this.buffer.byteLength > 0) {
              newBuffer.set(this.buffer, 0);
            }
            newBuffer.set(value, this.buffer.byteLength);
            return newBuffer;
          }
        };
        return VideoStreamBuffer2;
      }();
      exports.default = VideoStreamBuffer;
    }
  });

  // node_modules/h264-converter/dist/index.js
  var require_dist = __commonJS({
    "node_modules/h264-converter/dist/index.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var h264_remuxer_1 = require_h264_remuxer();
      var mp4_generator_1 = require_mp4_generator();
      var debug = require_debug();
      var nalu_stream_buffer_1 = require_nalu_stream_buffer();
      exports.mimeType = 'video/mp4; codecs="avc1.42E01E"';
      var debug_1 = require_debug();
      exports.setLogger = debug_1.setLogger;
      var VideoConverter2 = function() {
        function VideoConverter3(element, fps, fpf) {
          if (fps === void 0) {
            fps = 60;
          }
          if (fpf === void 0) {
            fpf = fps;
          }
          this.element = element;
          this.fps = fps;
          this.fpf = fpf;
          this.receiveBuffer = new nalu_stream_buffer_1.default();
          this.queue = [];
          if (!MediaSource || !MediaSource.isTypeSupported(exports.mimeType)) {
            throw new Error("Your browser is not supported: " + exports.mimeType);
          }
          this.reset();
        }
        Object.defineProperty(VideoConverter3, "errorNotes", {
          get: function() {
            var _a;
            return _a = {}, _a[MediaError.MEDIA_ERR_ABORTED] = "fetching process aborted by user", _a[MediaError.MEDIA_ERR_NETWORK] = "error occurred when downloading", _a[MediaError.MEDIA_ERR_DECODE] = "error occurred when decoding", _a[MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED] = "audio/video not supported", _a;
          },
          enumerable: true,
          configurable: true
        });
        VideoConverter3.prototype.setup = function() {
          var _this = this;
          this.mediaReadyPromise = new Promise(function(resolve, _reject) {
            _this.mediaSource.addEventListener("sourceopen", function() {
              debug.log("Media Source opened.");
              _this.sourceBuffer = _this.mediaSource.addSourceBuffer(exports.mimeType);
              _this.sourceBuffer.addEventListener("updateend", function() {
                debug.log("  SourceBuffer updateend");
                debug.log("    sourceBuffer.buffered.length=" + _this.sourceBuffer.buffered.length);
                for (var i = 0, len = _this.sourceBuffer.buffered.length; i < len; i++) {
                  debug.log("    sourceBuffer.buffered [" + i + "]: " + (_this.sourceBuffer.buffered.start(i) + ", " + _this.sourceBuffer.buffered.end(i)));
                }
                debug.log("  mediasource.duration=" + _this.mediaSource.duration);
                debug.log("  mediasource.readyState=" + _this.mediaSource.readyState);
                debug.log("  video.duration=" + _this.element.duration);
                debug.log("    video.buffered.length=" + _this.element.buffered.length);
                if (debug.isEnable()) {
                  for (var i = 0, len = _this.element.buffered.length; i < len; i++) {
                    debug.log("    video.buffered [" + i + "]: " + _this.element.buffered.start(i) + ", " + _this.element.buffered.end(i));
                  }
                }
                debug.log("  video.currentTime=" + _this.element.currentTime);
                debug.log("  video.readyState=" + _this.element.readyState);
                if (_this.sourceBuffer.updating) {
                  return;
                }
                var data = _this.queue.shift();
                if (data) {
                  _this.doAppend(data);
                }
              });
              _this.sourceBuffer.addEventListener("error", function() {
                debug.error("  SourceBuffer errored!");
              });
              _this.mediaReady = true;
              resolve();
            }, false);
            _this.mediaSource.addEventListener("sourceclose", function() {
              debug.log("Media Source closed.");
              _this.mediaReady = false;
            }, false);
            _this.element.src = URL.createObjectURL(_this.mediaSource);
          });
          return this.mediaReadyPromise;
        };
        VideoConverter3.prototype.play = function() {
          var _this = this;
          if (!this.element.paused) {
            return;
          }
          if (this.mediaReady && this.element.readyState >= 2) {
            this.element.play();
          } else {
            var handler_1 = function() {
              _this.play();
              _this.element.removeEventListener("canplaythrough", handler_1);
            };
            this.element.addEventListener("canplaythrough", handler_1);
          }
        };
        VideoConverter3.prototype.pause = function() {
          if (this.element.paused) {
            return;
          }
          this.element.pause();
        };
        VideoConverter3.prototype.reset = function() {
          this.receiveBuffer.clear();
          if (this.mediaSource && this.mediaSource.readyState === "open") {
            if (this.sourceBuffer.updating) {
              var mediaSource_1 = this.mediaSource;
              this.sourceBuffer.addEventListener("updateend", function() {
                mediaSource_1.endOfStream();
              });
            }
          }
          this.mediaSource = new MediaSource();
          this.remuxer = new h264_remuxer_1.default(this.fps, this.fpf, this.fps * 60);
          this.mediaReady = false;
          this.mediaReadyPromise = void 0;
          this.queue = [];
          this.setup();
        };
        VideoConverter3.prototype.appendRawData = function(data) {
          var nalus = this.receiveBuffer.append(data);
          for (var _i = 0, nalus_1 = nalus; _i < nalus_1.length; _i++) {
            var nalu = nalus_1[_i];
            var ret = this.remuxer.remux(nalu);
            if (ret) {
              this.writeFragment(ret[0], ret[1]);
            }
          }
        };
        VideoConverter3.prototype.writeFragment = function(dts, pay) {
          var remuxer = this.remuxer;
          if (remuxer.mp4track.isKeyFrame) {
            this.writeBuffer(mp4_generator_1.default.initSegment([remuxer.mp4track], Infinity, remuxer.timescale));
          }
          if (pay && pay.byteLength) {
            debug.log(" Put fragment: " + remuxer.seqNum + ", frames=" + remuxer.mp4track.samples.length + ", size=" + pay.byteLength);
            var fragment = mp4_generator_1.default.fragmentSegment(remuxer.seqNum, dts, remuxer.mp4track, pay);
            this.writeBuffer(fragment);
            remuxer.flush();
          } else {
            debug.error("Nothing payload!");
          }
        };
        VideoConverter3.prototype.writeBuffer = function(data) {
          var _this = this;
          if (this.mediaReady) {
            if (this.sourceBuffer.updating || this.queue.length) {
              this.queue.push(data);
            } else {
              this.doAppend(data);
            }
          } else {
            this.queue.push(data);
            if (this.mediaReadyPromise) {
              this.mediaReadyPromise.then(function() {
                if (!_this.sourceBuffer.updating) {
                  var d = _this.queue.shift();
                  if (d) {
                    _this.doAppend(d);
                  }
                }
              });
              this.mediaReadyPromise = void 0;
            }
          }
        };
        VideoConverter3.prototype.doAppend = function(data) {
          var error = this.element.error;
          if (error) {
            debug.error("MSE Error Occured: " + VideoConverter3.errorNotes[error.code]);
            this.element.pause();
            if (this.mediaSource.readyState === "open") {
              this.mediaSource.endOfStream();
            }
          } else {
            try {
              this.sourceBuffer.appendBuffer(data);
              debug.log("  appended buffer: size=" + data.byteLength);
            } catch (err) {
              debug.error("MSE Error occured while appending buffer. " + err.name + ": " + err.message);
            }
          }
        };
        return VideoConverter3;
      }();
      exports.default = VideoConverter2;
    }
  });

  // src/main.js
  var import_h264_converter = __toESM(require_dist());
  var import_h264_converter2 = __toESM(require_dist());
  var startButton = document.getElementById("startBtn");
  var stopButton = document.getElementById("stopBtn");
  var bitrateSelect = document.getElementById("bitrate");
  var maxSizeSelect = document.getElementById("maxSize");
  var maxFpsSelect = document.getElementById("maxFps");
  var enableAudioInput = document.getElementById("enableAudio");
  var statusDiv = document.getElementById("status");
  var themeToggle = document.getElementById("themeToggle");
  var fullscreenBtn = document.getElementById("fullscreenBtn");
  var streamArea = document.getElementById("streamArea");
  var videoPlaceholder = document.getElementById("videoPlaceholder");
  var videoElement = document.getElementById("screen");
  var infoDiv = document.getElementById("info");
  var ws = null;
  var converter = null;
  var isRunning = false;
  var audioContext = null;
  var audioBufferQueue = [];
  var nextAudioTime = 0;
  var audioCodecId = null;
  var receivedFirstAudioPacket = false;
  var deviceWidth = 0;
  var deviceHeight = 0;
  var videoResolution = "Unknown";
  var MAX_AUDIO_QUEUE_SIZE = 10;
  var AUDIO_SAMPLE_RATE = 48e3;
  var AUDIO_CHANNELS = 2;
  var AUDIO_BYTES_PER_SAMPLE = 2;
  var AUDIO_SAMPLE_SIZE = AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE;
  var BINARY_TYPES = {
    VIDEO: 0,
    AUDIO: 1
  };
  var CODEC_IDS = {
    H264: 1748121140,
    RAW: 7496055
  };
  function log(message) {
    console.log(message);
    infoDiv.textContent = message;
  }
  function setupAudioPlayer(codecId) {
    if (codecId !== CODEC_IDS.RAW) {
      log(`Unsupported audio codec ID: 0x${codecId.toString(16)}`);
      return;
    }
    if (!window.AudioContext && !window.webkitAudioContext) {
      log("Web Audio API not supported");
      return;
    }
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close().catch((e) => console.error(`Error closing previous AudioContext: ${e}`));
    }
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContext({ latencyHint: "interactive", sampleRate: AUDIO_SAMPLE_RATE });
      audioBufferQueue = [];
      nextAudioTime = 0;
      receivedFirstAudioPacket = false;
      audioCodecId = codecId;
      log("Audio player setup for RAW audio");
    } catch (e) {
      log(`Failed to create AudioContext: ${e}`);
      audioContext = null;
    }
  }
  function handleAudioData(arrayBuffer) {
    if (!audioContext || !isRunning || audioCodecId !== CODEC_IDS.RAW) return;
    if (arrayBuffer.byteLength === 0) return;
    if (arrayBuffer.byteLength % AUDIO_SAMPLE_SIZE !== 0) {
      console.warn(`Invalid audio data length: ${arrayBuffer.byteLength} bytes`);
      return;
    }
    const frameCount = arrayBuffer.byteLength / AUDIO_SAMPLE_SIZE;
    try {
      const audioBuffer = audioContext.createBuffer(AUDIO_CHANNELS, frameCount, AUDIO_SAMPLE_RATE);
      const float32Data = new Float32Array(frameCount);
      const int16Data = new Int16Array(arrayBuffer);
      for (let channel = 0; channel < AUDIO_CHANNELS; channel++) {
        for (let i = 0; i < frameCount; i++) {
          float32Data[i] = int16Data[i * AUDIO_CHANNELS + channel] / 32768;
        }
        audioBuffer.copyToChannel(float32Data, channel);
      }
      playAudioBuffer(audioBuffer);
    } catch (e) {
      console.error(`Error processing audio: ${e}`);
    }
  }
  function playAudioBuffer(buffer) {
    if (!audioContext || audioContext.state === "closed") {
      console.warn("Cannot play audio, context is closed or null.");
      return;
    }
    if (audioContext.state === "suspended") {
      audioContext.resume().catch((e) => console.error(`Audio context resume error: ${e}`));
    }
    if (audioBufferQueue.length >= MAX_AUDIO_QUEUE_SIZE) {
      const oldSource = audioBufferQueue.shift();
      try {
        oldSource.stop(0);
        oldSource.disconnect();
      } catch (e) {
      }
    }
    if (!receivedFirstAudioPacket) {
      nextAudioTime = audioContext.currentTime + 0.05;
      receivedFirstAudioPacket = true;
    }
    try {
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      const startTime = Math.max(audioContext.currentTime, nextAudioTime);
      source.start(startTime);
      nextAudioTime = startTime + buffer.duration;
      audioBufferQueue.push(source);
      source.onended = () => {
        const index = audioBufferQueue.indexOf(source);
        if (index > -1) audioBufferQueue.splice(index, 1);
        try {
          source.disconnect();
        } catch (e) {
        }
      };
    } catch (e) {
      console.error(`Error playing audio buffer: ${e}`);
      if (e.name === "InvalidStateError" && audioContext.state === "closed") {
        console.warn("AudioContext was closed during audio playback attempt.");
        audioContext = null;
      }
    }
  }
  function initVideoConverter() {
    if (converter) {
      converter = null;
    }
    const options = {
      fps: parseInt(maxFpsSelect.value),
      bitrate: parseInt(bitrateSelect.value)
    };
    converter = new import_h264_converter.default(videoElement, options.fps, 1);
    videoElement.addEventListener("loadedmetadata", () => {
      if (isRunning && videoPlaceholder.classList.contains("hidden")) {
        videoElement.play().catch((e) => console.warn("Autoplay prevented:", e));
      }
    }, { once: true });
  }
  function updateStatus(message) {
    statusDiv.textContent = `Status: ${message}`;
  }
  function startStreaming() {
    if (isRunning || ws && ws.readyState === WebSocket.OPEN) {
      log("Cannot start stream: Already running or WebSocket open.");
      return;
    }
    updateStatus("Connecting...");
    startButton.disabled = true;
    maxSizeSelect.disabled = true;
    maxFpsSelect.disabled = true;
    bitrateSelect.disabled = true;
    enableAudioInput.disabled = true;
    const wsUrl = `ws://${window.location.hostname}:8080`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    initVideoConverter();
    ws.onopen = () => {
      updateStatus("Connected. Requesting stream...");
      log("WebSocket opened. Sending start options.");
      const options = {
        action: "start",
        maxSize: parseInt(maxSizeSelect.value) || 0,
        maxFps: parseInt(maxFpsSelect.value) || 0,
        bitrate: (parseInt(bitrateSelect.value) || 8) * 1e6,
        enableAudio: enableAudioInput.checked
      };
      ws.send(JSON.stringify(options));
    };
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (!isRunning) return;
        const dataView = new DataView(event.data);
        if (dataView.byteLength < 1) return;
        const type = dataView.getUint8(0);
        const payload = event.data.slice(1);
        if (type === BINARY_TYPES.VIDEO && converter) {
          converter.appendRawData(new Uint8Array(payload));
        } else if (type === BINARY_TYPES.AUDIO && enableAudioInput.checked && audioContext) {
          handleAudioData(payload);
        }
      } else if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          switch (message.type) {
            case "status":
              updateStatus(message.message);
              log(`Status: ${message.message}`);
              if (message.message === "Streaming started") {
                isRunning = true;
                startButton.disabled = true;
                stopButton.disabled = false;
                maxSizeSelect.disabled = true;
                maxFpsSelect.disabled = true;
                bitrateSelect.disabled = true;
                enableAudioInput.disabled = true;
              } else if (message.message === "Streaming stopped") {
                stopStreaming(false);
              }
              break;
            case "videoInfo":
              videoResolution = `${message.width}x${message.height}`;
              deviceWidth = message.width;
              deviceHeight = message.height;
              log(`Video dimensions: ${videoResolution}`);
              if (deviceWidth > 0 && deviceHeight > 0) {
                streamArea.style.aspectRatio = `${deviceWidth} / ${deviceHeight}`;
              } else {
                streamArea.style.aspectRatio = "";
              }
              videoPlaceholder.classList.add("hidden");
              videoElement.classList.add("visible");
              if (converter && !converter.isPlaying) {
                converter.play();
                requestAnimationFrame(() => {
                  videoElement.play().catch((e) => console.warn("Autoplay prevented:", e));
                });
              }
              break;
            case "audioInfo":
              log(`Audio info: Codec ID 0x${message.codecId?.toString(16)}`);
              if (enableAudioInput.checked) {
                setupAudioPlayer(message.codecId);
              }
              break;
            default:
              log(`Unknown message type: ${message.type}`);
          }
        } catch (e) {
          console.error("Error parsing JSON message:", e, "Raw data:", event.data);
          updateStatus("Error processing server message");
        }
      }
    };
    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      updateStatus("WebSocket error");
      log("WebSocket error occurred.");
      stopStreaming(false);
    };
    ws.onclose = (event) => {
      const reason = event.reason || `code ${event.code}`;
      const statusMsg = event.wasClean ? `Disconnected (${reason})` : `Connection Lost (${reason})`;
      updateStatus(statusMsg);
      log(`WebSocket closed: ${statusMsg}`);
      stopStreaming(false);
    };
  }
  function stopStreaming(sendDisconnect = true) {
    if (!isRunning && !sendDisconnect && !(ws && ws.readyState < WebSocket.CLOSING)) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1e3, "Cleanup closure");
      }
      return;
    }
    isRunning = false;
    startButton.disabled = false;
    stopButton.disabled = true;
    maxSizeSelect.disabled = false;
    maxFpsSelect.disabled = false;
    bitrateSelect.disabled = false;
    enableAudioInput.disabled = false;
    if (ws) {
      if (sendDisconnect && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ action: "disconnect" }));
          log("Sent disconnect message.");
        } catch (e) {
          console.error("Error sending disconnect message:", e);
        }
      }
      if (ws.readyState < WebSocket.CLOSING) {
        ws.close(1e3, "User stopped streaming");
      }
      ws = null;
    }
    if (converter) {
      converter.pause();
      converter = null;
    }
    if (audioContext) {
      audioContext.close().then(() => log("AudioContext closed.")).catch((e) => console.error(`Error closing AudioContext: ${e}`));
      audioContext = null;
      audioBufferQueue.forEach((source) => {
        try {
          source.stop(0);
          source.disconnect();
        } catch (e) {
        }
      });
      audioBufferQueue = [];
      nextAudioTime = 0;
      audioCodecId = null;
      receivedFirstAudioPacket = false;
    }
    videoElement.pause();
    if (!videoElement.ended) {
      videoElement.currentTime = 0;
    }
    try {
      videoElement.src = "";
      videoElement.removeAttribute("src");
    } catch (e) {
    }
    try {
      videoElement.load();
    } catch (e) {
    }
    deviceWidth = 0;
    deviceHeight = 0;
    videoResolution = "Unknown";
    log("Stream stopped.");
    videoPlaceholder.classList.remove("hidden");
    videoElement.classList.remove("visible");
    streamArea.style.aspectRatio = "";
    if (document.fullscreenElement === videoElement) {
      document.exitFullscreen().catch((e) => console.error("Error exiting fullscreen:", e));
    }
    videoElement.classList.remove("fullscreen");
  }
  themeToggle.addEventListener("click", () => {
    const body = document.body;
    const currentTheme = body.getAttribute("data-theme");
    const newTheme = currentTheme === "dark" ? "light" : "dark";
    body.setAttribute("data-theme", newTheme);
    log(`Theme switched to ${newTheme}`);
  });
  var themeToggleTimeout;
  function showThemeToggle() {
    themeToggle.classList.remove("hidden");
    clearTimeout(themeToggleTimeout);
    themeToggleTimeout = setTimeout(() => {
      themeToggle.classList.add("hidden");
    }, 3e3);
  }
  document.addEventListener("mousemove", showThemeToggle);
  document.addEventListener("scroll", showThemeToggle);
  document.addEventListener("touchstart", showThemeToggle);
  showThemeToggle();
  fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      if (isRunning && videoElement.classList.contains("visible")) {
        videoElement.requestFullscreen().then(() => {
        }).catch((err) => {
          console.error(`Fullscreen error: ${err}`);
          log(`Failed to enter fullscreen: ${err.message}`);
        });
      } else {
        log("Cannot enter fullscreen: Stream not running.");
      }
    } else {
      document.exitFullscreen().then(() => {
      }).catch((err) => {
        console.error(`Exit fullscreen error: ${err}`);
        log(`Failed to exit fullscreen: ${err.message}`);
      });
    }
  });
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === videoElement) {
      if (!videoElement.classList.contains("fullscreen")) {
        videoElement.classList.add("fullscreen");
        log("Entered fullscreen");
      }
    } else {
      if (videoElement.classList.contains("fullscreen")) {
        videoElement.classList.remove("fullscreen");
        log("Exited fullscreen");
      }
    }
  });
  startButton.addEventListener("click", startStreaming);
  stopButton.addEventListener("click", () => stopStreaming(true));
  window.addEventListener("beforeunload", () => {
    if (isRunning || ws && ws.readyState === WebSocket.OPEN) {
      stopStreaming(true);
    }
  });
  stopButton.disabled = true;
  updateStatus("Idle");
  log("Page loaded. Ready.");
})();
