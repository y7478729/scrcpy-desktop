(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  var i
  for (i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],2:[function(require,module,exports){
(function (Buffer){(function (){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

}).call(this)}).call(this,require("buffer").Buffer)
},{"base64-js":1,"buffer":2,"ieee754":11}],3:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var bit_stream_1 = require("./util/bit-stream");
var debug = require("./util/debug");
var NALU_1 = require("./util/NALU");
var H264Parser = (function () {
    function H264Parser(remuxer) {
        this.remuxer = remuxer;
        this.track = remuxer.mp4track;
    }
    H264Parser.prototype.parseSEI = function (sei) {
        var messages = H264Parser.readSEI(sei);
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
    H264Parser.prototype.parseSPS = function (sps) {
        var config = H264Parser.readSPS(sps);
        this.track.width = config.width;
        this.track.height = config.height;
        this.track.sps = [sps];
        this.track.codec = 'avc1.';
        var codecArray = new DataView(sps.buffer, sps.byteOffset + 1, 4);
        for (var i = 0; i < 3; ++i) {
            var h = codecArray.getUint8(i).toString(16);
            if (h.length < 2) {
                h = '0' + h;
            }
            this.track.codec += h;
        }
    };
    H264Parser.prototype.parsePPS = function (pps) {
        this.track.pps = [pps];
    };
    H264Parser.prototype.parseNAL = function (unit) {
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
    H264Parser.skipScalingList = function (decoder, count) {
        var lastScale = 8;
        var nextScale = 8;
        for (var j = 0; j < count; j++) {
            if (nextScale !== 0) {
                var deltaScale = decoder.readEG();
                nextScale = (lastScale + deltaScale + 256) % 256;
            }
            lastScale = (nextScale === 0) ? lastScale : nextScale;
        }
    };
    H264Parser.readSPS = function (data) {
        var _a = this.parseSPS(data), pic_width_in_mbs_minus1 = _a.pic_width_in_mbs_minus1, frame_crop_left_offset = _a.frame_crop_left_offset, frame_crop_right_offset = _a.frame_crop_right_offset, frame_mbs_only_flag = _a.frame_mbs_only_flag, pic_height_in_map_units_minus1 = _a.pic_height_in_map_units_minus1, frame_crop_top_offset = _a.frame_crop_top_offset, frame_crop_bottom_offset = _a.frame_crop_bottom_offset, sar = _a.sar;
        var sarScale = sar[0] / sar[1];
        return {
            width: Math.ceil((((pic_width_in_mbs_minus1 + 1) * 16) - frame_crop_left_offset * 2 - frame_crop_right_offset * 2) * sarScale),
            height: ((2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16) -
                ((frame_mbs_only_flag ? 2 : 4) * (frame_crop_top_offset + frame_crop_bottom_offset)),
        };
    };
    H264Parser.parseSPS = function (data) {
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
        if (profile_idc === 100 ||
            profile_idc === 110 ||
            profile_idc === 122 ||
            profile_idc === 244 ||
            profile_idc === 44 ||
            profile_idc === 83 ||
            profile_idc === 86 ||
            profile_idc === 118 ||
            profile_idc === 128 ||
            profile_idc === 138 ||
            profile_idc === 139 ||
            profile_idc === 134) {
            var chromaFormatIdc = decoder.readUEG();
            if (chromaFormatIdc === 3) {
                decoder.skipBits(1);
            }
            decoder.skipUEG();
            decoder.skipUEG();
            decoder.skipBits(1);
            if (decoder.readBoolean()) {
                var scalingListCount = (chromaFormatIdc !== 3) ? 8 : 12;
                for (var i = 0; i < scalingListCount; ++i) {
                    if (decoder.readBoolean()) {
                        if (i < 6) {
                            H264Parser.skipScalingList(decoder, 16);
                        }
                        else {
                            H264Parser.skipScalingList(decoder, 64);
                        }
                    }
                }
            }
        }
        decoder.skipUEG();
        var picOrderCntType = decoder.readUEG();
        if (picOrderCntType === 0) {
            decoder.readUEG();
        }
        else if (picOrderCntType === 1) {
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
                    debug.log("timescale: " + timeScale + "; unitsInTick: " + unitsInTick + "; " +
                        ("fixedFramerate: " + fixedFrameRate + "; avgFrameDuration: " + frameDuration));
                }
                else {
                    debug.log("Truncated VUI (" + decoder.bitsAvailable + ")");
                }
            }
        }
        return {
            profile_idc: profile_idc,
            constraint_set_flags: constraint_set_flags,
            level_idc: level_idc,
            seq_parameter_set_id: seq_parameter_set_id,
            pic_width_in_mbs_minus1: pic_width_in_mbs_minus1,
            pic_height_in_map_units_minus1: pic_height_in_map_units_minus1,
            frame_mbs_only_flag: frame_mbs_only_flag,
            frame_crop_left_offset: frame_crop_left_offset,
            frame_crop_right_offset: frame_crop_right_offset,
            frame_crop_top_offset: frame_crop_top_offset,
            frame_crop_bottom_offset: frame_crop_bottom_offset,
            sar: sar,
        };
    };
    H264Parser.readSEI = function (data) {
        var decoder = new bit_stream_1.default(data);
        decoder.skipBits(8);
        var result = [];
        while (decoder.bitsAvailable > 3 * 8) {
            result.push(this.readSEIMessage(decoder));
        }
        return result;
    };
    H264Parser.readSEIMessage = function (decoder) {
        function get() {
            var result = 0;
            while (true) {
                var value = decoder.readUByte();
                result += value;
                if (value !== 0xff) {
                    break;
                }
            }
            return result;
        }
        var payloadType = get();
        var payloadSize = get();
        return this.readSEIPayload(decoder, payloadType, payloadSize);
    };
    H264Parser.readSEIPayload = function (decoder, type, size) {
        var result;
        switch (type) {
            default:
                result = { type: type };
                decoder.skipBits(size * 8);
        }
        decoder.skipBits(decoder.bitsAvailable % 8);
        return result;
    };
    return H264Parser;
}());
exports.default = H264Parser;

},{"./util/NALU":7,"./util/bit-stream":8,"./util/debug":9}],4:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var h264_parser_1 = require("./h264-parser");
var debug = require("./util/debug");
var NALU_1 = require("./util/NALU");
var trackId = 1;
var H264Remuxer = (function () {
    function H264Remuxer(fps, framePerFragment, timescale) {
        this.fps = fps;
        this.framePerFragment = framePerFragment;
        this.timescale = timescale;
        this.readyToDecode = false;
        this.totalDTS = 0;
        this.stepDTS = Math.round(this.timescale / this.fps);
        this.frameCount = 0;
        this.seq = 1;
        this.mp4track = {
            id: H264Remuxer.getTrackID(),
            type: 'video',
            len: 0,
            codec: '',
            sps: [],
            pps: [],
            seiBuffering: false,
            width: 0,
            height: 0,
            timescale: timescale,
            duration: timescale,
            samples: [],
            isKeyFrame: true,
        };
        this.unitSamples = [[]];
        this.parser = new h264_parser_1.default(this);
    }
    H264Remuxer.getTrackID = function () {
        return trackId++;
    };
    Object.defineProperty(H264Remuxer.prototype, "seqNum", {
        get: function () {
            return this.seq;
        },
        enumerable: true,
        configurable: true
    });
    H264Remuxer.prototype.remux = function (nalu) {
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
    H264Remuxer.prototype.createNextFrame = function () {
        if (this.mp4track.len > 0) {
            this.frameCount++;
            if (this.frameCount % this.framePerFragment === 0) {
                var fragment = this.getFragment();
                if (fragment) {
                    var dts = this.totalDTS;
                    this.totalDTS = this.stepDTS * this.frameCount;
                    return [dts, fragment];
                }
                else {
                    debug.log("No mp4 sample data.");
                }
            }
            this.unitSamples.push([]);
        }
        return;
    };
    H264Remuxer.prototype.flush = function () {
        this.seq++;
        this.mp4track.len = 0;
        this.mp4track.samples = [];
        this.mp4track.isKeyFrame = false;
        this.unitSamples = [[]];
    };
    H264Remuxer.prototype.getFragment = function () {
        if (!this.checkReadyToDecode()) {
            return undefined;
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
                cts: this.stepDTS * i,
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
            return undefined;
        }
        return payload;
    };
    H264Remuxer.prototype.checkReadyToDecode = function () {
        if (!this.readyToDecode || this.unitSamples.filter(function (array) { return array.length > 0; }).length === 0) {
            debug.log("Not ready to decode! readyToDecode(" + this.readyToDecode + ") is false or units is empty.");
            return false;
        }
        return true;
    };
    return H264Remuxer;
}());
exports.default = H264Remuxer;

},{"./h264-parser":3,"./util/NALU":7,"./util/debug":9}],5:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var h264_remuxer_1 = require("./h264-remuxer");
var mp4_generator_1 = require("./mp4-generator");
var debug = require("./util/debug");
var nalu_stream_buffer_1 = require("./util/nalu-stream-buffer");
exports.mimeType = 'video/mp4; codecs="avc1.42E01E"';
var debug_1 = require("./util/debug");
exports.setLogger = debug_1.setLogger;
var VideoConverter = (function () {
    function VideoConverter(element, fps, fpf) {
        if (fps === void 0) { fps = 60; }
        if (fpf === void 0) { fpf = fps; }
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
    Object.defineProperty(VideoConverter, "errorNotes", {
        get: function () {
            var _a;
            return _a = {},
                _a[MediaError.MEDIA_ERR_ABORTED] = 'fetching process aborted by user',
                _a[MediaError.MEDIA_ERR_NETWORK] = 'error occurred when downloading',
                _a[MediaError.MEDIA_ERR_DECODE] = 'error occurred when decoding',
                _a[MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED] = 'audio/video not supported',
                _a;
        },
        enumerable: true,
        configurable: true
    });
    VideoConverter.prototype.setup = function () {
        var _this = this;
        this.mediaReadyPromise = new Promise(function (resolve, _reject) {
            _this.mediaSource.addEventListener('sourceopen', function () {
                debug.log("Media Source opened.");
                _this.sourceBuffer = _this.mediaSource.addSourceBuffer(exports.mimeType);
                _this.sourceBuffer.addEventListener('updateend', function () {
                    debug.log("  SourceBuffer updateend");
                    debug.log("    sourceBuffer.buffered.length=" + _this.sourceBuffer.buffered.length);
                    for (var i = 0, len = _this.sourceBuffer.buffered.length; i < len; i++) {
                        debug.log("    sourceBuffer.buffered [" + i + "]: " +
                            (_this.sourceBuffer.buffered.start(i) + ", " + _this.sourceBuffer.buffered.end(i)));
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
                _this.sourceBuffer.addEventListener('error', function () {
                    debug.error('  SourceBuffer errored!');
                });
                _this.mediaReady = true;
                resolve();
            }, false);
            _this.mediaSource.addEventListener('sourceclose', function () {
                debug.log("Media Source closed.");
                _this.mediaReady = false;
            }, false);
            _this.element.src = URL.createObjectURL(_this.mediaSource);
        });
        return this.mediaReadyPromise;
    };
    VideoConverter.prototype.play = function () {
        var _this = this;
        if (!this.element.paused) {
            return;
        }
        if (this.mediaReady && this.element.readyState >= 2) {
            this.element.play();
        }
        else {
            var handler_1 = function () {
                _this.play();
                _this.element.removeEventListener('canplaythrough', handler_1);
            };
            this.element.addEventListener('canplaythrough', handler_1);
        }
    };
    VideoConverter.prototype.pause = function () {
        if (this.element.paused) {
            return;
        }
        this.element.pause();
    };
    VideoConverter.prototype.reset = function () {
        this.receiveBuffer.clear();
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
            if (this.sourceBuffer.updating) {
                var mediaSource_1 = this.mediaSource;
                this.sourceBuffer.addEventListener('updateend', function () {
                    mediaSource_1.endOfStream();
                });
            }
        }
        this.mediaSource = new MediaSource();
        this.remuxer = new h264_remuxer_1.default(this.fps, this.fpf, this.fps * 60);
        this.mediaReady = false;
        this.mediaReadyPromise = undefined;
        this.queue = [];
        this.setup();
    };
    VideoConverter.prototype.appendRawData = function (data) {
        var nalus = this.receiveBuffer.append(data);
        for (var _i = 0, nalus_1 = nalus; _i < nalus_1.length; _i++) {
            var nalu = nalus_1[_i];
            var ret = this.remuxer.remux(nalu);
            if (ret) {
                this.writeFragment(ret[0], ret[1]);
            }
        }
    };
    VideoConverter.prototype.writeFragment = function (dts, pay) {
        var remuxer = this.remuxer;
        if (remuxer.mp4track.isKeyFrame) {
            this.writeBuffer(mp4_generator_1.default.initSegment([remuxer.mp4track], Infinity, remuxer.timescale));
        }
        if (pay && pay.byteLength) {
            debug.log(" Put fragment: " + remuxer.seqNum + ", frames=" + remuxer.mp4track.samples.length + ", size=" + pay.byteLength);
            var fragment = mp4_generator_1.default.fragmentSegment(remuxer.seqNum, dts, remuxer.mp4track, pay);
            this.writeBuffer(fragment);
            remuxer.flush();
        }
        else {
            debug.error("Nothing payload!");
        }
    };
    VideoConverter.prototype.writeBuffer = function (data) {
        var _this = this;
        if (this.mediaReady) {
            if (this.sourceBuffer.updating || this.queue.length) {
                this.queue.push(data);
            }
            else {
                this.doAppend(data);
            }
        }
        else {
            this.queue.push(data);
            if (this.mediaReadyPromise) {
                this.mediaReadyPromise.then(function () {
                    if (!_this.sourceBuffer.updating) {
                        var d = _this.queue.shift();
                        if (d) {
                            _this.doAppend(d);
                        }
                    }
                });
                this.mediaReadyPromise = undefined;
            }
        }
    };
    VideoConverter.prototype.doAppend = function (data) {
        var error = this.element.error;
        if (error) {
            debug.error("MSE Error Occured: " + VideoConverter.errorNotes[error.code]);
            this.element.pause();
            if (this.mediaSource.readyState === 'open') {
                this.mediaSource.endOfStream();
            }
        }
        else {
            try {
                this.sourceBuffer.appendBuffer(data);
                debug.log("  appended buffer: size=" + data.byteLength);
            }
            catch (err) {
                debug.error("MSE Error occured while appending buffer. " + err.name + ": " + err.message);
            }
        }
    };
    return VideoConverter;
}());
exports.default = VideoConverter;

},{"./h264-remuxer":4,"./mp4-generator":6,"./util/debug":9,"./util/nalu-stream-buffer":10}],6:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var MP4 = (function () {
    function MP4() {
    }
    MP4.init = function () {
        MP4.initalized = true;
        MP4.types = {
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
            smhd: [],
        };
        for (var type in MP4.types) {
            if (MP4.types.hasOwnProperty(type)) {
                MP4.types[type] = [
                    type.charCodeAt(0),
                    type.charCodeAt(1),
                    type.charCodeAt(2),
                    type.charCodeAt(3),
                ];
            }
        }
        var hdlr = new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x76, 0x69, 0x64, 0x65,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x56, 0x69, 0x64, 0x65,
            0x6f, 0x48, 0x61, 0x6e,
            0x64, 0x6c, 0x65, 0x72, 0x00,
        ]);
        var dref = new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x0c,
            0x75, 0x72, 0x6c, 0x20,
            0x00,
            0x00, 0x00, 0x01,
        ]);
        var stco = new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ]);
        MP4.STTS = MP4.STSC = MP4.STCO = stco;
        MP4.STSZ = new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ]);
        MP4.VMHD = new Uint8Array([
            0x00,
            0x00, 0x00, 0x01,
            0x00, 0x00,
            0x00, 0x00,
            0x00, 0x00,
            0x00, 0x00,
        ]);
        MP4.SMHD = new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00,
            0x00, 0x00,
        ]);
        MP4.STSD = new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01
        ]);
        MP4.FTYP = MP4.box(MP4.types.ftyp, new Uint8Array([
            0x69, 0x73, 0x6f, 0x35,
            0x00, 0x00, 0x00, 0x01,
            0x61, 0x76, 0x63, 0x31,
            0x69, 0x73, 0x6f, 0x35,
            0x64, 0x61, 0x73, 0x68,
        ]));
        MP4.STYP = MP4.box(MP4.types.styp, new Uint8Array([
            0x6d, 0x73, 0x64, 0x68,
            0x00, 0x00, 0x00, 0x00,
            0x6d, 0x73, 0x64, 0x68,
            0x6d, 0x73, 0x69, 0x78,
        ]));
        MP4.DINF = MP4.box(MP4.types.dinf, MP4.box(MP4.types.dref, dref));
        MP4.HDLR = MP4.box(MP4.types.hdlr, hdlr);
    };
    MP4.box = function (type) {
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
        result[0] = (size >> 24) & 0xff;
        result[1] = (size >> 16) & 0xff;
        result[2] = (size >> 8) & 0xff;
        result[3] = size & 0xff;
        result.set(type, 4);
        size = 8;
        for (var _b = 0, payload_2 = payload; _b < payload_2.length; _b++) {
            var box = payload_2[_b];
            result.set(box, size);
            size += box.byteLength;
        }
        return result;
    };
    MP4.mdat = function (data) {
        return MP4.box(MP4.types.mdat, data);
    };
    MP4.mdhd = function (timescale) {
        return MP4.box(MP4.types.mdhd, new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x02,
            (timescale >> 24) & 0xFF,
            (timescale >> 16) & 0xFF,
            (timescale >> 8) & 0xFF,
            timescale & 0xFF,
            0x00, 0x00, 0x00, 0x00,
            0x55, 0xc4,
            0x00, 0x00,
        ]));
    };
    MP4.mdia = function (track) {
        return MP4.box(MP4.types.mdia, MP4.mdhd(track.timescale), MP4.HDLR, MP4.minf(track));
    };
    MP4.mfhd = function (sequenceNumber) {
        return MP4.box(MP4.types.mfhd, new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            (sequenceNumber >> 24),
            (sequenceNumber >> 16) & 0xFF,
            (sequenceNumber >> 8) & 0xFF,
            sequenceNumber & 0xFF,
        ]));
    };
    MP4.minf = function (track) {
        return MP4.box(MP4.types.minf, MP4.box(MP4.types.vmhd, MP4.VMHD), MP4.DINF, MP4.stbl(track));
    };
    MP4.moof = function (sn, baseMediaDecodeTime, track) {
        return MP4.box(MP4.types.moof, MP4.mfhd(sn), MP4.traf(track, baseMediaDecodeTime));
    };
    MP4.moov = function (tracks, duration, timescale) {
        var boxes = [];
        for (var _i = 0, tracks_1 = tracks; _i < tracks_1.length; _i++) {
            var track = tracks_1[_i];
            boxes.push(MP4.trak(track));
        }
        return MP4.box.apply(MP4, [MP4.types.moov, MP4.mvhd(timescale, duration), MP4.mvex(tracks)].concat(boxes));
    };
    MP4.mvhd = function (timescale, duration) {
        var bytes = new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x02,
            (timescale >> 24) & 0xFF,
            (timescale >> 16) & 0xFF,
            (timescale >> 8) & 0xFF,
            timescale & 0xFF,
            (duration >> 24) & 0xFF,
            (duration >> 16) & 0xFF,
            (duration >> 8) & 0xFF,
            duration & 0xFF,
            0x00, 0x01, 0x00, 0x00,
            0x01, 0x00,
            0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x40, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x02,
        ]);
        return MP4.box(MP4.types.mvhd, bytes);
    };
    MP4.mvex = function (tracks) {
        var boxes = [];
        for (var _i = 0, tracks_2 = tracks; _i < tracks_2.length; _i++) {
            var track = tracks_2[_i];
            boxes.push(MP4.trex(track));
        }
        return MP4.box.apply(MP4, [MP4.types.mvex].concat(boxes, [MP4.trep()]));
    };
    MP4.trep = function () {
        return MP4.box(MP4.types.trep, new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01,
        ]));
    };
    MP4.stbl = function (track) {
        return MP4.box(MP4.types.stbl, MP4.stsd(track), MP4.box(MP4.types.stts, MP4.STTS), MP4.box(MP4.types.stsc, MP4.STSC), MP4.box(MP4.types.stsz, MP4.STSZ), MP4.box(MP4.types.stco, MP4.STCO));
    };
    MP4.avc1 = function (track) {
        var sps = [];
        var pps = [];
        for (var _i = 0, _a = track.sps; _i < _a.length; _i++) {
            var data = _a[_i];
            var len = data.byteLength;
            sps.push((len >>> 8) & 0xFF);
            sps.push((len & 0xFF));
            sps = sps.concat(Array.prototype.slice.call(data));
        }
        for (var _b = 0, _c = track.pps; _b < _c.length; _b++) {
            var data = _c[_b];
            var len = data.byteLength;
            pps.push((len >>> 8) & 0xFF);
            pps.push((len & 0xFF));
            pps = pps.concat(Array.prototype.slice.call(data));
        }
        var avcc = MP4.box(MP4.types.avcC, new Uint8Array([
            0x01,
            sps[3],
            sps[4],
            sps[5],
            0xfc | 3,
            0xE0 | track.sps.length,
        ].concat(sps).concat([
            track.pps.length,
        ]).concat(pps)));
        var width = track.width;
        var height = track.height;
        return MP4.box(MP4.types.avc1, new Uint8Array([
            0x00, 0x00, 0x00,
            0x00, 0x00, 0x00,
            0x00, 0x01,
            0x00, 0x00,
            0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            (width >> 8) & 0xFF,
            width & 0xff,
            (height >> 8) & 0xFF,
            height & 0xff,
            0x00, 0x48, 0x00, 0x00,
            0x00, 0x48, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x01,
            0x12,
            0x62, 0x69, 0x6E, 0x65,
            0x6C, 0x70, 0x72, 0x6F,
            0x2E, 0x72, 0x75, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00,
            0x00, 0x18,
            0x11, 0x11
        ]), avcc, MP4.box(MP4.types.btrt, new Uint8Array([
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x2d, 0xc6, 0xc0,
            0x00, 0x2d, 0xc6, 0xc0,
        ])));
    };
    MP4.stsd = function (track) {
        return MP4.box(MP4.types.stsd, MP4.STSD, MP4.avc1(track));
    };
    MP4.tkhd = function (track) {
        var id = track.id;
        var width = track.width;
        var height = track.height;
        return MP4.box(MP4.types.tkhd, new Uint8Array([
            0x00,
            0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x02,
            (id >> 24) & 0xFF,
            (id >> 16) & 0xFF,
            (id >> 8) & 0xFF,
            id & 0xFF,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00,
            0x00, 0x00,
            (track.type === 'audio' ? 0x01 : 0x00), 0x00,
            0x00, 0x00,
            0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x40, 0x00, 0x00, 0x00,
            (width >> 8) & 0xFF,
            width & 0xFF,
            0x00, 0x00,
            (height >> 8) & 0xFF,
            height & 0xFF,
            0x00, 0x00,
        ]));
    };
    MP4.traf = function (track, baseMediaDecodeTime) {
        var id = track.id;
        return MP4.box(MP4.types.traf, MP4.box(MP4.types.tfhd, new Uint8Array([
            0x00,
            0x02, 0x00, 0x00,
            (id >> 24),
            (id >> 16) & 0XFF,
            (id >> 8) & 0XFF,
            (id & 0xFF),
        ])), MP4.box(MP4.types.tfdt, new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            (baseMediaDecodeTime >> 24),
            (baseMediaDecodeTime >> 16) & 0XFF,
            (baseMediaDecodeTime >> 8) & 0XFF,
            (baseMediaDecodeTime & 0xFF),
        ])), MP4.trun(track, 16 +
            16 +
            8 +
            16 +
            8 +
            8));
    };
    MP4.trak = function (track) {
        track.duration = track.duration || 0xffffffff;
        return MP4.box(MP4.types.trak, MP4.tkhd(track), MP4.mdia(track));
    };
    MP4.trex = function (track) {
        var id = track.id;
        return MP4.box(MP4.types.trex, new Uint8Array([
            0x00,
            0x00, 0x00, 0x00,
            (id >> 24),
            (id >> 16) & 0XFF,
            (id >> 8) & 0XFF,
            (id & 0xFF),
            0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x3c,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x01, 0x00, 0x00,
        ]));
    };
    MP4.trun = function (track, offset) {
        var samples = track.samples || [];
        var len = samples.length;
        var additionalLen = track.isKeyFrame ? 4 : 0;
        var arraylen = 12 + additionalLen + (4 * len);
        var array = new Uint8Array(arraylen);
        offset += 8 + arraylen;
        array.set([
            0x00,
            0x00, 0x02, (track.isKeyFrame ? 0x05 : 0x01),
            (len >>> 24) & 0xFF,
            (len >>> 16) & 0xFF,
            (len >>> 8) & 0xFF,
            len & 0xFF,
            (offset >>> 24) & 0xFF,
            (offset >>> 16) & 0xFF,
            (offset >>> 8) & 0xFF,
            offset & 0xFF,
        ], 0);
        if (track.isKeyFrame) {
            array.set([
                0x00, 0x00, 0x00, 0x00,
            ], 12);
        }
        for (var i = 0; i < len; i++) {
            var sample = samples[i];
            var size = sample.size;
            array.set([
                (size >>> 24) & 0xFF,
                (size >>> 16) & 0xFF,
                (size >>> 8) & 0xFF,
                size & 0xFF,
            ], 12 + additionalLen + 4 * i);
        }
        return MP4.box(MP4.types.trun, array);
    };
    MP4.initSegment = function (tracks, duration, timescale) {
        if (!MP4.initalized) {
            MP4.init();
        }
        var movie = MP4.moov(tracks, duration, timescale);
        var result = new Uint8Array(MP4.FTYP.byteLength + movie.byteLength);
        result.set(MP4.FTYP);
        result.set(movie, MP4.FTYP.byteLength);
        return result;
    };
    MP4.fragmentSegment = function (sn, baseMediaDecodeTime, track, payload) {
        var moof = MP4.moof(sn, baseMediaDecodeTime, track);
        var mdat = MP4.mdat(payload);
        var result = new Uint8Array(MP4.STYP.byteLength + moof.byteLength + mdat.byteLength);
        result.set(MP4.STYP);
        result.set(moof, MP4.STYP.byteLength);
        result.set(mdat, MP4.STYP.byteLength + moof.byteLength);
        return result;
    };
    MP4.types = {};
    MP4.initalized = false;
    return MP4;
}());
exports.default = MP4;

},{}],7:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var NALU = (function () {
    function NALU(data) {
        this.data = data;
        this.nri = (data[0] & 0x60) >> 5;
        this.ntype = data[0] & 0x1f;
    }
    Object.defineProperty(NALU, "NDR", {
        get: function () { return 1; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(NALU, "IDR", {
        get: function () { return 5; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(NALU, "SEI", {
        get: function () { return 6; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(NALU, "SPS", {
        get: function () { return 7; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(NALU, "PPS", {
        get: function () { return 8; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(NALU, "TYPES", {
        get: function () {
            var _a;
            return _a = {},
                _a[NALU.IDR] = 'IDR',
                _a[NALU.SEI] = 'SEI',
                _a[NALU.SPS] = 'SPS',
                _a[NALU.PPS] = 'PPS',
                _a[NALU.NDR] = 'NDR',
                _a;
        },
        enumerable: true,
        configurable: true
    });
    NALU.type = function (nalu) {
        if (nalu.ntype in NALU.TYPES) {
            return NALU.TYPES[nalu.ntype];
        }
        else {
            return 'UNKNOWN';
        }
    };
    NALU.prototype.type = function () {
        return this.ntype;
    };
    NALU.prototype.isKeyframe = function () {
        return this.ntype === NALU.IDR;
    };
    NALU.prototype.getSize = function () {
        return 4 + this.data.byteLength;
    };
    NALU.prototype.getData = function () {
        var result = new Uint8Array(this.getSize());
        var view = new DataView(result.buffer);
        view.setUint32(0, this.getSize() - 4);
        result.set(this.data, 4);
        return result;
    };
    return NALU;
}());
exports.default = NALU;

},{}],8:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var BitStream = (function () {
    function BitStream(data) {
        this.data = data;
        this.index = 0;
        this.bitLength = data.byteLength * 8;
    }
    Object.defineProperty(BitStream.prototype, "bitsAvailable", {
        get: function () {
            return this.bitLength - this.index;
        },
        enumerable: true,
        configurable: true
    });
    BitStream.prototype.skipBits = function (size) {
        if (this.bitsAvailable < size) {
            throw new Error('no bytes available');
        }
        this.index += size;
    };
    BitStream.prototype.readBits = function (size) {
        var result = this.getBits(size, this.index);
        return result;
    };
    BitStream.prototype.getBits = function (size, offsetBits, moveIndex) {
        if (moveIndex === void 0) { moveIndex = true; }
        if (this.bitsAvailable < size) {
            throw new Error('no bytes available');
        }
        var offset = offsetBits % 8;
        var byte = this.data[(offsetBits / 8) | 0] & (0xff >>> offset);
        var bits = 8 - offset;
        if (bits >= size) {
            if (moveIndex) {
                this.index += size;
            }
            return byte >> (bits - size);
        }
        else {
            if (moveIndex) {
                this.index += bits;
            }
            var nextSize = size - bits;
            return (byte << nextSize) | this.getBits(nextSize, offsetBits + bits, moveIndex);
        }
    };
    BitStream.prototype.skipLZ = function () {
        var leadingZeroCount;
        for (leadingZeroCount = 0; leadingZeroCount < this.bitLength - this.index; ++leadingZeroCount) {
            if (0 !== this.getBits(1, this.index + leadingZeroCount, false)) {
                this.index += leadingZeroCount;
                return leadingZeroCount;
            }
        }
        return leadingZeroCount;
    };
    BitStream.prototype.skipUEG = function () {
        this.skipBits(1 + this.skipLZ());
    };
    BitStream.prototype.skipEG = function () {
        this.skipBits(1 + this.skipLZ());
    };
    BitStream.prototype.readUEG = function () {
        var prefix = this.skipLZ();
        return this.readBits(prefix + 1) - 1;
    };
    BitStream.prototype.readEG = function () {
        var value = this.readUEG();
        if (0x01 & value) {
            return (1 + value) >>> 1;
        }
        else {
            return -1 * (value >>> 1);
        }
    };
    BitStream.prototype.readBoolean = function () {
        return 1 === this.readBits(1);
    };
    BitStream.prototype.readUByte = function () {
        return this.readBits(8);
    };
    BitStream.prototype.readUShort = function () {
        return this.readBits(16);
    };
    BitStream.prototype.readUInt = function () {
        return this.readBits(32);
    };
    return BitStream;
}());
exports.default = BitStream;

},{}],9:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var mLogger;
var mErrorLogger;
function setLogger(logger, errorLogger) {
    mLogger = logger;
    mErrorLogger = errorLogger != null ? errorLogger : logger;
}
exports.setLogger = setLogger;
function isEnable() {
    return mLogger != null;
}
exports.isEnable = isEnable;
function log(message) {
    var optionalParams = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        optionalParams[_i - 1] = arguments[_i];
    }
    if (mLogger) {
        mLogger.apply(void 0, [message].concat(optionalParams));
    }
}
exports.log = log;
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

},{}],10:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var NALU_1 = require("./NALU");
var VideoStreamBuffer = (function () {
    function VideoStreamBuffer() {
    }
    VideoStreamBuffer.prototype.clear = function () {
        this.buffer = undefined;
    };
    VideoStreamBuffer.prototype.append = function (value) {
        var nextNalHeader = function (b) {
            var i = 3;
            return function () {
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
    VideoStreamBuffer.prototype.mergeBuffer = function (value) {
        if (this.buffer == null) {
            return Uint8Array.from(value);
        }
        else {
            var newBuffer = new Uint8Array(this.buffer.byteLength + value.length);
            if (this.buffer.byteLength > 0) {
                newBuffer.set(this.buffer, 0);
            }
            newBuffer.set(value, this.buffer.byteLength);
            return newBuffer;
        }
    };
    return VideoStreamBuffer;
}());
exports.default = VideoStreamBuffer;

},{"./NALU":7}],11:[function(require,module,exports){
/*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> */
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],12:[function(require,module,exports){
(function (Buffer){(function (){
const VideoConverter = require('h264-converter').default;
const { setLogger } = require('h264-converter');

setLogger(() => {}, console.error);

// Constants (Video)
const CHECK_STATE_INTERVAL_MS = 250;
const MAX_SEEK_WAIT_MS = 1500;
const MAX_TIME_TO_RECOVER = 200;
const IS_SAFARI = !!window.safari;
const IS_CHROME = navigator.userAgent.includes('Chrome');
const IS_MAC = navigator.platform.startsWith('Mac');
const MAX_BUFFER = IS_SAFARI ? 2 : IS_CHROME && IS_MAC ? 0.9 : 0.2;
const MAX_AHEAD = -0.2;
const DEFAULT_FRAMES_PER_SECOND = 60;
const DEFAULT_FRAMES_PER_FRAGMENT = 1;
const NALU_TYPE_IDR = 5;

// Constants (Audio/Control)
const AUDIO_BYTES_PER_SAMPLE = 2;
const BINARY_TYPES = { VIDEO: 0, AUDIO: 1 };
const CODEC_IDS = { H264: 0x68323634, AAC: 0x00616163 };
const CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT = 2;
const AMOTION_EVENT_ACTION_DOWN = 0;
const AMOTION_EVENT_ACTION_UP = 1;
const AMOTION_EVENT_ACTION_MOVE = 2;
const AMOTION_EVENT_BUTTON_PRIMARY = 1;
const AMOTION_EVENT_BUTTON_SECONDARY = 2;
const AMOTION_EVENT_BUTTON_TERTIARY = 4;
const POINTER_ID_MOUSE = -1n;

// DOM Elements
const elements = {
    startButton: document.getElementById('startBtn'),
    stopButton: document.getElementById('stopBtn'),
    bitrateSelect: document.getElementById('bitrate'),
    maxSizeSelect: document.getElementById('maxSize'),
    maxFpsSelect: document.getElementById('maxFps'),
    enableAudioInput: document.getElementById('enableAudio'),
    enableControlInput: document.getElementById('enableControl'),
    statusDiv: document.getElementById('status'),
    themeToggle: document.getElementById('themeToggle'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    streamArea: document.getElementById('streamArea'),
    videoPlaceholder: document.getElementById('videoPlaceholder'),
    videoElement: document.getElementById('screen'),
    videoBorder: document.getElementById('videoBorder'),
    flipOrientationBtn: document.getElementById('flipOrientationBtn'),
};

// State
let state = {
    ws: null,
    converter: null,
    isRunning: false,
    audioContext: null,
    audioDecoder: null,
    audioCodecId: null,
    audioMetadata: null,
    receivedFirstAudioPacket: false,
    deviceWidth: 0,
    deviceHeight: 0,
    videoResolution: 'Unknown',
    checkStateIntervalId: null,
    sourceBufferInternal: null,
    currentTimeNotChangedSince: -1,
    bigBufferSince: -1,
    aheadOfBufferSince: -1,
    lastVideoTime: -1,
    seekingSince: -1,
    removeStart: -1,
    removeEnd: -1,
    videoStats: [],
    inputBytes: [],
    momentumQualityStats: null,
    noDecodedFramesSince: -1,
    controlEnabledAtStart: false,
    isMouseDown: false,
    currentMouseButtons: 0,
    lastMousePosition: { x: 0, y: 0 },
    nextAudioTime: 0,
    totalAudioFrames: 0,
};

// Utility Functions
const log = (message) => {
    console.log(message);
};

const updateStatus = (message) => {
    elements.statusDiv.textContent = `Status: ${message}`;
};

const updateVideoBorder = () => {
    const video = elements.videoElement;
    const border = elements.videoBorder;
    const container = elements.streamArea;

    if (!state.isRunning || state.deviceWidth === 0 || state.deviceHeight === 0 || !video.classList.contains('visible')) {
        border.style.display = 'none';
        return;
    }

    const videoWidth = state.deviceWidth;
    const videoHeight = state.deviceHeight;
    const elementWidth = video.clientWidth;
    const elementHeight = video.clientHeight;

    if (elementWidth === 0 || elementHeight === 0) {
        border.style.display = 'none';
        return;
    }

    const videoAspectRatio = videoWidth / videoHeight;
    const elementAspectRatio = elementWidth / elementHeight;

    let renderedVideoWidth, renderedVideoHeight;
    let offsetX = 0, offsetY = 0;

    if (elementAspectRatio > videoAspectRatio) {
        renderedVideoHeight = elementHeight;
        renderedVideoWidth = elementHeight * videoAspectRatio;
        offsetX = (elementWidth - renderedVideoWidth) / 2;
    } else {
        renderedVideoWidth = elementWidth;
        renderedVideoHeight = elementWidth / videoAspectRatio;
        offsetY = (elementHeight - renderedVideoHeight) / 2;
    }

    const borderLeft = video.offsetLeft + offsetX;
    const borderTop = video.offsetTop + offsetY;

    border.style.left = `${borderLeft}px`;
    border.style.top = `${borderTop}px`;
    const borderWidth = 3;
    border.style.width = `${renderedVideoWidth}px`;
    border.style.height = `${renderedVideoHeight}px`;
    border.style.display = 'block';
};

const isIFrame = (frameData) => {
    if (!frameData || frameData.length < 1) return false;
    let offset = frameData.length > 4 && frameData[0] === 0 && frameData[1] === 0 && frameData[2] === 0 && frameData[3] === 1 ? 4 :
                 frameData.length > 3 && frameData[0] === 0 && frameData[1] === 0 && frameData[2] === 1 ? 3 : 0;
    return frameData.length > offset && (frameData[offset] & 0x1F) === NALU_TYPE_IDR;
};

// Video Handling
const initVideoConverter = () => {
    const fps = parseInt(elements.maxFpsSelect.value) || DEFAULT_FRAMES_PER_SECOND;
    state.converter = new VideoConverter(elements.videoElement, fps, DEFAULT_FRAMES_PER_FRAGMENT);
    state.sourceBufferInternal = state.converter?.sourceBuffer || null;

    elements.videoElement.addEventListener('canplay', onVideoCanPlay, { once: true });
    elements.videoElement.removeEventListener('error', onVideoError);
    elements.videoElement.addEventListener('error', onVideoError);
};

const onVideoCanPlay = () => {
    if (state.isRunning) {
        elements.videoElement.play().catch(e => console.warn("Autoplay prevented:", e));
    }
};

const onVideoError = (e) => {
    console.error('Video Element Error:', e);
    log(`Video Error: ${elements.videoElement.error?.message} (Code: ${elements.videoElement.error?.code})`);
};

const cleanSourceBuffer = () => {
    if (!state.sourceBufferInternal || state.sourceBufferInternal.updating || state.removeStart < 0 || state.removeEnd <= state.removeStart) {
        state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
        state.removeStart = state.removeEnd = -1;
        return;
    }

    try {
        console.log(`Removing source buffer range: ${state.removeStart.toFixed(3)} - ${state.removeEnd.toFixed(3)}`);
        state.sourceBufferInternal.remove(state.removeStart, state.removeEnd);
        state.sourceBufferInternal.addEventListener('updateend', cleanSourceBuffer, { once: true });
    } catch (e) {
        console.error(`Failed to clean source buffer: ${e}`);
        state.sourceBufferInternal?.removeEventListener('updateend', cleanSourceBuffer);
        state.removeStart = state.removeEnd = -1;
    }
};

const checkForIFrameAndCleanBuffer = (frameData) => {
    if (IS_SAFARI || !isIFrame(frameData)) {
        return;
    }

    if (!state.sourceBufferInternal) {
        state.sourceBufferInternal = state.converter?.sourceBuffer || null;
        if (!state.sourceBufferInternal) return;
    }

    if (elements.videoElement.buffered && elements.videoElement.buffered.length) {
        const start = elements.videoElement.buffered.start(0);
        const end = elements.videoElement.buffered.end(0) | 0;

        if (end !== 0 && start < end) {
            if (state.removeEnd !== -1) {
                state.removeEnd = end;
            } else {
                state.removeStart = start;
                state.removeEnd = end;
            }
            state.sourceBufferInternal.addEventListener('updateend', cleanSourceBuffer, { once: true });
        }
    }
};

// Video Playback Quality
const getVideoPlaybackQuality = () => {
    const video = elements.videoElement;
    if (!video) return null;

    const now = Date.now();
    if (typeof video.getVideoPlaybackQuality === 'function') {
        const temp = video.getVideoPlaybackQuality();
        return {
            timestamp: now,
            decodedFrames: temp.totalVideoFrames,
            droppedFrames: temp.droppedVideoFrames,
        };
    }

    if (typeof video.webkitDecodedFrameCount !== 'undefined') {
        return {
            timestamp: now,
            decodedFrames: video.webkitDecodedFrameCount,
            droppedFrames: video.webkitDroppedFrameCount,
        };
    }
    return null;
};

const calculateMomentumStats = () => {
    const stat = getVideoPlaybackQuality();
    if (!stat) return;

    const timestamp = Date.now();
    const oneSecondBefore = timestamp - 1000;
    state.videoStats.push(stat);
    state.videoStats = state.videoStats.filter(s => s.timestamp >= oneSecondBefore);
    state.inputBytes = state.inputBytes.filter(b => b.timestamp >= oneSecondBefore);

    const inputBytes = state.inputBytes.reduce((sum, item) => sum + item.bytes, 0);
    const inputFrames = state.inputBytes.length;

    if (state.videoStats.length) {
        const oldest = state.videoStats[0];
        const decodedFrames = stat.decodedFrames - oldest.decodedFrames;
        const droppedFrames = stat.droppedFrames - oldest.droppedFrames;
        state.momentumQualityStats = {
            decodedFrames,
            droppedFrames,
            inputBytes,
            inputFrames,
            timestamp,
        };
    }
};

const checkForBadState = () => {
    if (!state.isRunning || !state.converter) return;

    const { currentTime } = elements.videoElement;
    const now = Date.now();
    let hasReasonToJump = false;

    calculateMomentumStats();

    if (state.momentumQualityStats) {
        if (state.momentumQualityStats.decodedFrames === 0 && state.momentumQualityStats.inputFrames > 0) {
            if (state.noDecodedFramesSince === -1) {
                state.noDecodedFramesSince = now;
            } else {
                const time = now - state.noDecodedFramesSince;
                if (time > MAX_TIME_TO_RECOVER) {
                    hasReasonToJump = true;
                }
            }
        } else {
            state.noDecodedFramesSince = -1;
        }
    }

    if (currentTime === state.lastVideoTime && state.currentTimeNotChangedSince === -1) {
        state.currentTimeNotChangedSince = now;
    } else {
        state.currentTimeNotChangedSince = -1;
    }
    state.lastVideoTime = currentTime;

    if (elements.videoElement.buffered.length) {
        const end = elements.videoElement.buffered.end(0);
        const buffered = end - currentTime;

        if ((end | 0) - currentTime > MAX_BUFFER) {
            if (state.bigBufferSince === -1) {
                state.bigBufferSince = now;
            } else {
                const time = now - state.bigBufferSince;
                if (time > MAX_TIME_TO_RECOVER) {
                    hasReasonToJump = true;
                }
            }
        } else {
            state.bigBufferSince = -1;
        }

        if (buffered < MAX_AHEAD) {
            if (state.aheadOfBufferSince === -1) {
                state.aheadOfBufferSince = now;
            } else {
                const time = now - state.aheadOfBufferSince;
                if (time > MAX_TIME_TO_RECOVER) {
                    hasReasonToJump = true;
                }
            }
        } else {
            state.aheadOfBufferSince = -1;
        }

        if (state.currentTimeNotChangedSince !== -1) {
            const time = now - state.currentTimeNotChangedSince;
            if (time > MAX_TIME_TO_RECOVER) {
                hasReasonToJump = true;
            }
        }

        if (!hasReasonToJump) return;

        let waitingForSeekEnd = 0;
        if (state.seekingSince !== -1) {
            waitingForSeekEnd = now - state.seekingSince;
            if (waitingForSeekEnd < MAX_SEEK_WAIT_MS) {
                return;
            }
        }

        const onSeekEnd = () => {
            state.seekingSince = -1;
            elements.videoElement.removeEventListener('seeked', onSeekEnd);
            elements.videoElement.play().catch(e => console.warn("Autoplay prevented after seek:", e));
        };

        if (state.seekingSince !== -1) {
            console.warn(`Attempt to seek while already seeking! ${waitingForSeekEnd}`);
        }
        state.seekingSince = now;
        elements.videoElement.addEventListener('seeked', onSeekEnd);
        elements.videoElement.currentTime = end;
    }
};

// Audio Handling (Unchanged)
const setupAudioPlayer = (codecId, metadata) => {
    if (codecId !== CODEC_IDS.AAC) {
        log(`Unsupported audio codec ID: 0x${codecId.toString(16)}`);
        return;
    }
    if (!window.AudioContext || !window.AudioDecoder) {
        updateStatus('Audio not supported in this browser');
        return;
    }

    try {
        state.audioContext = new AudioContext({
            sampleRate: metadata.sampleRate || 48000,
        });

        state.audioDecoder = new AudioDecoder({
            output: (audioData) => {
                try {
                    const numberOfChannels = audioData.numberOfChannels;
                    const sampleRate = audioData.sampleRate;
                    const bufferLength = Math.max(audioData.numberOfFrames, 8192);
                    const buffer = state.audioContext.createBuffer(
                        numberOfChannels,
                        bufferLength,
                        sampleRate
                    );

                    const isInterleaved = audioData.format === 'f32' || audioData.format === 'f32-interleaved';
                    if (isInterleaved) {
                        const interleavedData = new Float32Array(audioData.numberOfFrames * numberOfChannels);
                        audioData.copyTo(interleavedData, { planeIndex: 0 });

                        for (let channel = 0; channel < numberOfChannels; channel++) {
                            const channelData = buffer.getChannelData(channel);
                            for (let i = 0; i < audioData.numberOfFrames; i++) {
                                channelData[i] = interleavedData[i * numberOfChannels + channel];
                            }
                        }
                    } else {
                        for (let channel = 0; channel < numberOfChannels; channel++) {
                            audioData.copyTo(buffer.getChannelData(channel), { planeIndex: channel });
                        }
                    }

                    const source = state.audioContext.createBufferSource();
                    source.buffer = buffer;
                    source.connect(state.audioContext.destination);
                    const currentTime = state.audioContext.currentTime;
                    const bufferDuration = audioData.numberOfFrames / sampleRate;
                    state.nextAudioTime = Math.max(state.nextAudioTime, currentTime);
                    source.start(state.nextAudioTime);
                    state.nextAudioTime += bufferDuration;
                } catch (e) {
                    console.error(`Error processing decoded audio: ${e}`);
                }
            },
            error: (error) => {
                console.error(`AudioDecoder error: ${error}`);
            },
        });

        state.audioDecoder.configure({
            codec: 'mp4a.40.2',
            sampleRate: metadata.sampleRate || 48000,
            numberOfChannels: metadata.channelConfig || 2,
        });

        state.audioCodecId = codecId;
        state.audioMetadata = metadata;
        state.receivedFirstAudioPacket = false;
        state.nextAudioTime = 0;
        state.totalAudioFrames = 0;
    } catch (e) {
        log(`Failed to setup AudioDecoder: ${e}`);
        state.audioDecoder = null;
        state.audioContext = null;
        updateStatus('Failed to initialize audio');
    }
};

const handleAudioData = (arrayBuffer) => {
    if (!state.audioDecoder || !state.isRunning || state.audioCodecId !== CODEC_IDS.AAC || arrayBuffer.byteLength === 0) return;

    try {
        const uint8Array = new Uint8Array(arrayBuffer);
        const sampleRate = state.audioMetadata?.sampleRate || 48000;
        const frameDuration = 1024 / sampleRate * 1000000;
        state.audioDecoder.decode(new EncodedAudioChunk({
            type: 'key',
            timestamp: state.totalAudioFrames * frameDuration,
            data: uint8Array,
        }));
        state.totalAudioFrames += 1024;
        state.receivedFirstAudioPacket = true;
    } catch (e) {
        console.error(`Error decoding audio data: ${e}`);
    }
};

// Coordinate Scaling Function (Unchanged)
const getScaledCoordinates = (event) => {
    const video = elements.videoElement;
    const screenInfo = {
        videoSize: { width: state.deviceWidth, height: state.deviceHeight }
    };

    if (!screenInfo || !screenInfo.videoSize || !screenInfo.videoSize.width || !screenInfo.videoSize.height) {
        return null;
    }
    const { width, height } = screenInfo.videoSize;
    const target = video;
    const rect = target.getBoundingClientRect();
    let { clientWidth, clientHeight } = target;

    let touchX = event.clientX - rect.left;
    let touchY = event.clientY - rect.top;

    const videoRatio = width / height;
    const elementRatio = clientWidth / clientHeight;

    if (elementRatio > videoRatio) {
        const realWidth = clientHeight * videoRatio;
        const barsWidth = (clientWidth - realWidth) / 2;
        if (touchX < barsWidth || touchX > barsWidth + realWidth) {
            return null;
        }
        touchX -= barsWidth;
        clientWidth = realWidth;
    } else if (elementRatio < videoRatio) {
        const realHeight = clientWidth / videoRatio;
        const barsHeight = (clientHeight - realHeight) / 2;
        if (touchY < barsHeight || touchY > barsHeight + realHeight) {
            return null;
        }
        touchY -= barsHeight;
        clientHeight = realHeight;
    }

    let deviceX = Math.round((touchX * width) / clientWidth);
    let deviceY = Math.round((touchY * height) / clientHeight);

    deviceX = Math.max(0, Math.min(width, deviceX));
    deviceY = Math.max(0, Math.min(height, deviceY));

    return { x: deviceX, y: deviceY };
};

// Control Message Sending (Unchanged)
const sendControlMessage = (buffer) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.controlEnabledAtStart) {
        try {
            state.ws.send(buffer);
        } catch (e) {
            console.error("Failed to send control message:", e);
        }
    }
};

const sendMouseEvent = (action, buttons, x, y) => {
    if (!state.deviceWidth || !state.deviceHeight || !state.controlEnabledAtStart) return;

    const buffer = new ArrayBuffer(32);
    const dataView = new DataView(buffer);

    dataView.setUint8(0, CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT);
    dataView.setUint8(1, action);
    dataView.setBigInt64(2, POINTER_ID_MOUSE, false);
    dataView.setInt32(10, x, false);
    dataView.setInt32(14, y, false);
    dataView.setUint16(18, state.deviceWidth, false);
    dataView.setUint16(20, state.deviceHeight, false);
    dataView.setUint16(22, 0xFFFF, false);
    dataView.setUint32(24, 0, false);
    dataView.setUint32(28, buttons, false);

    sendControlMessage(buffer);
};

// Mouse Event Handlers (Unchanged)
const handleMouseDown = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight) return;
    event.preventDefault();

    state.isMouseDown = true;
    let buttonFlag = 0;
    switch(event.button) {
        case 0: buttonFlag = AMOTION_EVENT_BUTTON_PRIMARY; break;
        case 1: buttonFlag = AMOTION_EVENT_BUTTON_TERTIARY; break;
        case 2: buttonFlag = AMOTION_EVENT_BUTTON_SECONDARY; break;
        default: return;
    }
    state.currentMouseButtons |= buttonFlag;

    const coords = getScaledCoordinates(event);
    if (coords) {
        state.lastMousePosition = coords;
        sendMouseEvent(AMOTION_EVENT_ACTION_DOWN, state.currentMouseButtons, coords.x, coords.y);
    } else {
        console.warn(`Mouse Down - Invalid coordinates: Raw: (${event.clientX}, ${event.clientY})`);
    }
};

const handleMouseUp = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight) return;
    event.preventDefault();

    let buttonFlag = 0;
    switch(event.button) {
        case 0: buttonFlag = AMOTION_EVENT_BUTTON_PRIMARY; break;
        case 1: buttonFlag = AMOTION_EVENT_BUTTON_TERTIARY; break;
        case 2: buttonFlag = AMOTION_EVENT_BUTTON_SECONDARY; break;
        default: return;
    }

    if (!(state.currentMouseButtons & buttonFlag)) {
        return;
    }

    const coords = getScaledCoordinates(event);
    const finalCoords = coords || state.lastMousePosition;

    sendMouseEvent(AMOTION_EVENT_ACTION_UP, state.currentMouseButtons, finalCoords.x, finalCoords.y);

    state.currentMouseButtons &= ~buttonFlag;

    if (state.currentMouseButtons === 0) {
        state.isMouseDown = false;
    } else {
        sendMouseEvent(AMOTION_EVENT_ACTION_MOVE, state.currentMouseButtons, finalCoords.x, finalCoords.y);
    }
};

const handleMouseMove = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.deviceWidth || !state.deviceHeight || !state.isMouseDown) return;
    event.preventDefault();

    const coords = getScaledCoordinates(event);
    if (coords) {
        state.lastMousePosition = coords;
        sendMouseEvent(AMOTION_EVENT_ACTION_MOVE, state.currentMouseButtons, coords.x, coords.y);
    } else {
        console.warn(`Mouse Move - Invalid coordinates: Raw: (${event.clientX}, ${event.clientY})`);
    }
};

const handleMouseLeave = (event) => {
    if (!state.isRunning || !state.controlEnabledAtStart || !state.isMouseDown || state.currentMouseButtons === 0) return;
    event.preventDefault();

    console.log(`Mouse leave while buttons pressed: ${state.currentMouseButtons}`);
    sendMouseEvent(AMOTION_EVENT_ACTION_UP, state.currentMouseButtons, state.lastMousePosition.x, state.lastMousePosition.y);

    state.isMouseDown = false;
    state.currentMouseButtons = 0;
};

// Streaming
const startStreaming = () => {
    if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
        log('Cannot start stream: Already running or WebSocket open');
        return;
    }

    updateStatus('Connecting...');
    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    elements.maxSizeSelect.disabled = true;
    elements.maxFpsSelect.disabled = true;
    elements.bitrateSelect.disabled = true;
    elements.enableAudioInput.disabled = true;
    elements.enableControlInput.disabled = true;
    elements.flipOrientationBtn.disabled = true;

    state.controlEnabledAtStart = elements.enableControlInput.checked;

    Object.assign(state, {
        ws: null,
        converter: null,
        audioContext: null,
        audioDecoder: null,
        sourceBufferInternal: null,
        checkStateIntervalId: null,
        currentTimeNotChangedSince: -1,
        bigBufferSince: -1,
        aheadOfBufferSince: -1,
        lastVideoTime: -1,
        seekingSince: -1,
        removeStart: -1,
        removeEnd: -1,
        receivedFirstAudioPacket: false,
        audioMetadata: null,
        videoStats: [],
        inputBytes: [],
        momentumQualityStats: null,
        noDecodedFramesSince: -1,
        isMouseDown: false,
        currentMouseButtons: 0,
        lastMousePosition: { x: 0, y: 0 },
        nextAudioTime: 0,
        totalAudioFrames: 0,
        deviceWidth: 0,
        deviceHeight: 0,
        videoResolution: 'Unknown',
        isRunning: true,
    });

    state.ws = new WebSocket(`ws://${window.location.hostname}:8080`);
    state.ws.binaryType = 'arraybuffer';

    state.ws.onopen = () => {
        log('WebSocket connected');
        updateStatus('Connected, initializing stream...');
        const message = {
            action: 'start',
            maxSize: parseInt(elements.maxSizeSelect.value) || 0,
            maxFps: parseInt(elements.maxFpsSelect.value) || 0,
            bitrate: (parseInt(elements.bitrateSelect.value) || 8) * 1000000,
            enableAudio: elements.enableAudioInput.checked,
            enableControl: state.controlEnabledAtStart,
            video: true,
        };
        state.ws.send(JSON.stringify(message));
        initVideoConverter();
    };

    state.ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            try {
                const message = JSON.parse(event.data);
                switch (message.type) {
                    case 'deviceName':
                        log(`Device Name: ${message.name}`);
                        updateStatus(`Connected to ${message.name}`);
                        break;
                    case 'videoInfo':
                        state.deviceWidth = message.width;
                        state.deviceHeight = message.height;
                        state.videoResolution = `${message.width}x${message.height}`;
                        log(`Video Info: Codec=0x${message.codecId.toString(16)}, ${state.videoResolution}`);
                        elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0
                            ? `${state.deviceWidth} / ${state.deviceHeight}`
                            : '9 / 16';
                        elements.videoPlaceholder.classList.add('hidden');
                        elements.videoElement.classList.add('visible');
                        if (state.converter) {
                            requestAnimationFrame(() => {
                                elements.videoElement.play().catch(e => console.warn("Autoplay prevented:", e));
                                setTimeout(updateVideoBorder, 50);
                            });
                        } else {
                            setTimeout(updateVideoBorder, 50);
                        }
                        break;
                    case 'audioInfo':
                        log(`Audio Info: Codec=0x${message.codecId.toString(16)}${message.metadata ? `, Metadata=${JSON.stringify(message.metadata)}` : ''}`);
                        if (message.codecId === CODEC_IDS.AAC && message.metadata && elements.enableAudioInput.checked) {
                            setupAudioPlayer(message.codecId, message.metadata);
                        }
                        break;
                    case 'status':
                        log(`Status: ${message.message}`);
                        updateStatus(message.message);
                        if (message.message === 'Streaming started') {
                            elements.flipOrientationBtn.disabled = false;
                            elements.videoElement.classList.toggle('control-enabled', state.controlEnabledAtStart);
                            state.checkStateIntervalId = setInterval(checkForBadState, CHECK_STATE_INTERVAL_MS);
                        } else if (message.message === 'Streaming stopped') {
                            stopStreaming(false);
                        }
                        break;
                    case 'error':
                        log(`Error: ${message.message}`);
                        updateStatus(`Error: ${message.message}`);
                        stopStreaming(false);
                        break;
                    case 'deviceMessage':
                        try {
                            const deviceData = new Uint8Array(Buffer.from(message.data, 'base64'));
                            log(`Device Message: ${deviceData.length} bytes`);
                        } catch (e) {
                            console.error(`Error processing device message: ${e}`);
                        }
                        break;
                    default:
                        log(`Unknown message type: ${message.type}`);
                }
            } catch (e) {
                console.error(`Error parsing JSON message: ${e}`);
            }
        } else if (event.data instanceof ArrayBuffer) {
            const dataView = new DataView(event.data);
            if (dataView.byteLength < 1) return;

            const type = dataView.getUint8(0);
            const payload = event.data.slice(1);
            const payloadUint8 = new Uint8Array(payload);

            if (type === BINARY_TYPES.VIDEO && state.converter) {
                state.inputBytes.push({ timestamp: Date.now(), bytes: payload.byteLength });
                state.converter.appendRawData(payloadUint8);
                checkForIFrameAndCleanBuffer(payloadUint8);
            } else if (type === BINARY_TYPES.AUDIO && elements.enableAudioInput.checked) {
                handleAudioData(payload);
            }
        }
    };

    state.ws.onclose = (event) => {
        log(`WebSocket closed (Code: ${event.code}, Reason: ${event.reason})`);
        stopStreaming(false);
    };

    state.ws.onerror = (error) => {
        console.error(`WebSocket error: ${error}`);
        updateStatus('WebSocket error');
        stopStreaming(false);
    };
};

const stopStreaming = (sendDisconnect = true) => {
    if (!state.isRunning && !sendDisconnect && !(state.ws && state.ws.readyState < WebSocket.CLOSING)) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.close(1000, 'Cleanup closure');
        }
        return;
    }

    if (state.ws && state.ws.readyState === WebSocket.OPEN && sendDisconnect) {
        try {
            state.ws.send(JSON.stringify({ action: 'disconnect' }));
        } catch (e) {
            console.error("Error sending disconnect message:", e);
        }
        state.ws.close(1000, 'User stopped streaming');
    }
    state.ws = null;

    if (state.checkStateIntervalId) {
        clearInterval(state.checkStateIntervalId);
        state.checkStateIntervalId = null;
    }

    if (state.audioDecoder) {
        state.audioDecoder.close();
        state.audioDecoder = null;
    }
    if (state.audioContext) {
        state.audioContext.close();
        state.audioContext = null;
    }
    state.audioMetadata = null;
    state.receivedFirstAudioPacket = false;
    state.nextAudioTime = 0;
    state.totalAudioFrames = 0;

    if (state.converter) {
        try {
            state.converter.appendRawData(new Uint8Array([]));
            state.converter.pause();
            state.converter = null;
        } catch (e) {
            console.error("Error during converter cleanup:", e);
        }
    }
    state.sourceBufferInternal = null;

    elements.videoElement.pause();
    try {
        elements.videoElement.src = "";
        elements.videoElement.removeAttribute('src');
        elements.videoElement.load();
    } catch (e) {}

    elements.videoElement.classList.remove('visible');
    elements.videoElement.classList.remove('control-enabled');
    elements.videoPlaceholder.classList.remove('hidden');
    elements.videoBorder.style.display = 'none';
    elements.streamArea.style.aspectRatio = '9 / 16';

    if (!sendDisconnect) {
        state.isRunning = false;
        updateStatus('Disconnected');
        elements.startButton.disabled = false;
        elements.stopButton.disabled = true;
        elements.maxSizeSelect.disabled = false;
        elements.maxFpsSelect.disabled = false;
        elements.bitrateSelect.disabled = false;
        elements.enableAudioInput.disabled = false;
        elements.enableControlInput.disabled = false;
        elements.flipOrientationBtn.disabled = true;
    }

    Object.assign(state, {
        currentTimeNotChangedSince: -1,
        bigBufferSince: -1,
        aheadOfBufferSince: -1,
        lastVideoTime: -1,
        seekingSince: -1,
        removeStart: -1,
        removeEnd: -1,
        videoStats: [],
        inputBytes: [],
        momentumQualityStats: null,
        noDecodedFramesSince: -1,
        isMouseDown: false,
        currentMouseButtons: 0,
        lastMousePosition: { x: 0, y: 0 },
        deviceWidth: 0,
        deviceHeight: 0,
        videoResolution: 'Unknown',
    });
};

// Event Listeners (Unchanged)
elements.startButton.addEventListener('click', startStreaming);
elements.stopButton.addEventListener('click', () => stopStreaming(true));
elements.themeToggle.addEventListener('click', () => {
    const body = document.body;
    const newTheme = body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', newTheme);
    log(`Theme switched to ${newTheme}`);
});

let themeToggleTimeout;
const showThemeToggle = () => {
    elements.themeToggle.classList.remove('hidden');
    clearTimeout(themeToggleTimeout);
    themeToggleTimeout = setTimeout(() => elements.themeToggle.classList.add('hidden'), 3000);
};

['mousemove', 'scroll', 'touchstart'].forEach(event =>
    document.addEventListener(event, showThemeToggle)
);
showThemeToggle();

elements.fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        if (state.isRunning && elements.videoElement.classList.contains('visible')) {
            elements.videoElement.requestFullscreen().catch(e => console.error(`Fullscreen error: ${e}`));
        } else {
            log("Cannot enter fullscreen: Stream not running");
        }
    } else {
        document.exitFullscreen();
    }
});

document.addEventListener('fullscreenchange', () => {
    elements.videoElement.classList.toggle('fullscreen', document.fullscreenElement === elements.videoElement);
    log(document.fullscreenElement ? 'Entered fullscreen' : 'Exited fullscreen');
});

elements.flipOrientationBtn.addEventListener('click', () => {
    if (!state.isRunning) {
        log("Cannot flip orientation: Stream not running");
        return;
    }
    if (state.deviceWidth > 0 && state.deviceHeight > 0) {
        log(`Flipping orientation from ${state.deviceWidth}x${state.deviceHeight}`);
        const tempWidth = state.deviceWidth;
        state.deviceWidth = state.deviceHeight;
        state.deviceHeight = tempWidth;
        state.videoResolution = `${state.deviceWidth}x${state.deviceHeight}`;

        log(`New orientation: ${state.deviceWidth}x${state.deviceHeight}`);
        elements.streamArea.style.aspectRatio = state.deviceWidth > 0 && state.deviceHeight > 0
            ? `${state.deviceWidth} / ${state.deviceHeight}`
            : '9 / 16';

        requestAnimationFrame(() => {
            updateVideoBorder();
        });
    } else {
        log("Cannot flip orientation: Dimensions not set");
    }
});

window.addEventListener('beforeunload', () => {
    if (state.isRunning || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
        stopStreaming(true);
    }
});

elements.videoElement.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
elements.videoElement.addEventListener('mousemove', handleMouseMove);
elements.videoElement.addEventListener('mouseleave', handleMouseLeave);
elements.videoElement.addEventListener('contextmenu', (e) => {
    if (state.controlEnabledAtStart && state.isRunning) {
        e.preventDefault();
    }
});

const resizeObserver = new ResizeObserver(() => {
    updateVideoBorder();
});
resizeObserver.observe(elements.videoElement);

// Initialize
updateStatus('Idle');
elements.stopButton.disabled = true;
elements.flipOrientationBtn.disabled = true;
updateVideoBorder();
}).call(this)}).call(this,require("buffer").Buffer)
},{"buffer":2,"h264-converter":5}]},{},[12]);
