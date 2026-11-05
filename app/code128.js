/* Code128 ชุด B → SVG (ใช้พิมพ์ป้าย LOC:/EMP:/DEV:) */
var Code128 = (function () {
  'use strict';
  var W = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
    '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 ' +
    '111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
    '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 ' +
    '141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 ' +
    '124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 ' +
    '311141 411131 211412 211214 211232 2331112').split(' ');

  function values(text) {
    var v = [104];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 32 || c > 126) throw new Error('Code128-B รองรับเฉพาะ ASCII: ' + text);
      v.push(c - 32);
    }
    var sum = v[0];
    for (var j = 1; j < v.length; j++) sum += v[j] * j;
    v.push(sum % 103);
    v.push(106);
    return v;
  }

  /** คืนสตริงโมดูล 1/0 (ใช้ทดสอบ) */
  function modules(text) {
    return values(text).map(function (val) {
      var w = W[val], out = '';
      for (var i = 0; i < w.length; i++) out += new Array(+w[i] + 1).join(i % 2 ? '0' : '1');
      return out;
    }).join('');
  }

  /** SVG: module = ความกว้างหนึ่งโมดูล (px), height = ความสูงแท่ง, quiet zone 10 โมดูล */
  function svg(text, opt) {
    opt = opt || {};
    var m = opt.module || 2, h = opt.height || 60, q = 10;
    var bits = modules(text), x = q * m, rects = '';
    for (var i = 0; i < bits.length;) {
      if (bits[i] === '1') {
        var j = i;
        while (j < bits.length && bits[j] === '1') j++;
        rects += '<rect x="' + (q * m + i * m) + '" y="0" width="' + ((j - i) * m) + '" height="' + h + '"/>';
        i = j;
      } else i++;
    }
    var width = (bits.length + 2 * q) * m;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + h + '" viewBox="0 0 ' + width + ' ' + h +
      '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
  }

  return { modules: modules, svg: svg, values: values };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Code128;
