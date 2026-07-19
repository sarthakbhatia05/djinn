/* The orb, rendered as a WebGL fragment shader.
 *
 * This replaced a canvas2D particle system. That version drew ~2600 soft
 * gradient sprites onto a 180x180 backing store, which caps how good it can
 * ever look: at that resolution every grain is a 3-4px smear, so the result
 * reads as grain and blur no matter how the particles are tuned. A shader has
 * no such ceiling — cost is per pixel, not per particle.
 *
 * What it draws: an analytically intersected sphere, surface-shaded. Not a
 * volumetric march. A march was tried first and looked *worse* than the
 * particles: sampling 3D fbm at 14 steps undersamples it badly, so the result
 * was a patchy blob with alpha peaking at a third of the radius and dying
 * before the limb. High-frequency noise is also just the wrong target — a
 * smooth sphere with a bright fresnel rim is what reads as premium, and it
 * needs exactly one surface hit per pixel.
 *
 * The look is four things stacked, in order of how much they matter:
 *   1. Fresnel rim. Grazing-angle pixels take the hot colour. This is what
 *      turns a flat circle into a lit sphere; it does more than everything
 *      else combined.
 *   2. A single diffuse key light, up and to the left, giving a terminator.
 *   3. Low-frequency fbm over the rotating surface normal, at ~2 cycles across
 *      the whole sphere. Deliberately low: it should read as depth in a
 *      material, not as texture. High frequencies here are what made the
 *      march look noisy.
 *   4. An outer halo so the orb sits in a pool of its own light.
 *
 * Colours are premultiplied and blended ONE / ONE_MINUS_SRC_ALPHA into the
 * canvas's own transparent buffer. That's why there is no light/dark
 * compositing branch: the old 2D renderer had to switch between 'lighter' and
 * 'source-over' because it composited straight onto the page, and additive
 * blending has no headroom above a cream background. Here the orb is composed
 * in isolation and the browser alpha-blends the finished image, so the theme
 * only decides which colours go in.
 *
 * Exposes window.OrbGL.create(canvas) -> renderer, or null if WebGL is
 * unavailable. Callers must handle null; app.js keeps the 2D path as fallback.
 */
(function () {
  'use strict';

  var VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = aPos;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}',
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'varying vec2 vUv;',
    '',
    'uniform float uAngle;',   // accumulated spin, radians (eased in JS)
    'uniform float uTime;',    // seconds, for the internal drift
    'uniform float uActive;',  // 0..1, an agent is running
    'uniform float uBurst;',   // 0..1, one-shot expansion
    'uniform float uLight;',   // 1.0 on the cream theme
    'uniform vec3  uBody;',    // bulk colour
    'uniform vec3  uHot;',     // lit / rim colour
    '',
    'float hash(vec3 p) {',
    '  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));',
    '  p *= 17.0;',
    '  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));',
    '}',
    'float noise(vec3 x) {',
    '  vec3 i = floor(x);',
    '  vec3 f = fract(x);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(hash(i + vec3(0.0,0.0,0.0)), hash(i + vec3(1.0,0.0,0.0)), f.x),',
    '                 mix(hash(i + vec3(0.0,1.0,0.0)), hash(i + vec3(1.0,1.0,0.0)), f.x), f.y),',
    '             mix(mix(hash(i + vec3(0.0,0.0,1.0)), hash(i + vec3(1.0,0.0,1.0)), f.x),',
    '                 mix(hash(i + vec3(0.0,1.0,1.0)), hash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);',
    '}',
    // 4 octaves is affordable now that it runs once per pixel rather than once
    // per march step.
    'float fbm(vec3 p) {',
    '  float a = 0.5;',
    '  float s = 0.0;',
    '  for (int i = 0; i < 4; i++) {',
    '    s += a * noise(p);',
    '    p *= 2.03;',   // non-integer lacunarity keeps octaves from aligning
    '    a *= 0.5;',
    '  }',
    '  return s;',
    '}',
    '',
    'void main() {',
    '  vec2 uv = vUv;',
    '  float R = 0.62 * (1.0 + uBurst * 0.16);',
    '',
    // Proper pinhole camera: all rays leave one point. An earlier version put
    // the origin at vec3(uv, 3.0) so every ray started at its own pixel and
    // diverged, which shrank the true silhouette to |uv|~0.47 while the halo
    // below still keyed off R=0.62 — a visibly detached ring with a dead gap.
    //
    // FOV is chosen so the silhouette lands exactly at SIL: the sphere's
    // angular radius is asin(R/3.2), and tan of that over SIL gives the scale.
    // Keep these three in step if you retune the size.
    '  const float SIL = 0.63;',
    '  vec3 ro = vec3(0.0, 0.0, 3.2);',
    '  vec3 rd = normalize(vec3(uv * 0.3134, -1.0));',
    '',
    '  float b = dot(ro, rd);',
    '  float c = dot(ro, ro) - R * R;',
    '  float h = b * b - c;',
    '',
    '  vec3 col = vec3(0.0);',
    '  float alpha = 0.0;',
    '',
    '  float ca = cos(uAngle);',
    '  float sa = sin(uAngle);',
    '  float ct = cos(0.42);',
    '  float st = sin(0.42);',
    '',
    '  vec3 key = normalize(vec3(-0.42, 0.62, 0.66));',
    '',
    '  if (h > 0.0) {',
    '    float t = -b - sqrt(h);',
    '    vec3 pos = ro + rd * t;',
    '    vec3 n = normalize(pos);',
    '',
    // Rotate the sampling frame, not the geometry: the sphere stays put and
    // its surface pattern turns inside it. Tilted axis, or the drift just
    // slides sideways and reads as a scrolling texture instead of a spin.
    '    vec3 q = vec3(n.x * ca + n.z * sa, n.y, -n.x * sa + n.z * ca);',
    '    q = vec3(q.x, q.y * ct - q.z * st, q.y * st + q.z * ct);',
    '',
    // ~2 cycles across the sphere. See the header note: this is depth in a
    // material, not surface texture.
    '    float swirl = fbm(q * 2.1 + vec3(0.0, uTime * 0.05, uTime * 0.02));',
    '    swirl = smoothstep(0.28, 0.78, swirl);',
    '',
    '    float diff = max(dot(n, key), 0.0);',
    // Exponent 1.8, not 3.0. A tight rim is a thin bright outline, which is
    // exactly the plastic-billiard-ball read; a wide one behaves like light
    // scattering through a translucent body, which is what the reference orbs
    // are actually doing.
    '    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 1.8);',
    '    vec3  ref  = reflect(rd, n);',
    // Broad and weak. A tight hot specular is the single strongest "hard shiny
    // plastic" cue there is; widening it turns the same highlight into a soft
    // sheen across the material.
    '    float spec = pow(max(dot(ref, key), 0.0), 10.0);',
    '',
    // Body colour: the swirl and the key light both pull toward the hot tone,
    // so lit regions and dense regions share a palette and the sphere stays
    // one material rather than looking like two colours pasted together.
    // Fresnel weighted 0.80 rather than 1.05. The rim term is wide (see the
    // exponent above), so a heavy weight here tints most of the surface, not
    // just the limb, and the body colour stops being visible at all.
    '    float mixAmt = clamp(swirl * 0.45 + pow(diff, 1.3) * 0.50 + fres * 0.80, 0.0, 1.0);',
    '    vec3 base = mix(uBody, uHot, mixAmt);',
    '',
    // Ambient floor of 0.30 so the dark side is still visibly the same
    // material and not a black bite out of the circle.
    '    float lum = 0.34 + 0.80 * diff + 1.25 * fres + 0.30 * spec;',
    // Swirl now carries real contrast rather than a 10% wobble. This is the
    // internal structure that stops the sphere reading as moulded plastic;
    // it's still only ~2 cycles across the whole surface, so it reads as
    // depth in the material rather than as texture painted on it.
    '    lum *= 0.72 + 0.62 * swirl;',
    '    lum *= 1.0 + uActive * 0.30;',
    // Reinhard tonemap. These terms stack to ~3.6 at the key light, and the
    // premultiply clamp below is a hard clip — so without this the whole lit
    // shoulder flattens into a single blown-out white patch and the swirl
    // detail dies exactly where the orb is brightest. Rolling off instead
    // keeps structure visible in the highlight.
    '    lum = lum / (1.0 + lum * 0.62);',
    '',
    '    col = base * lum;',
    '',
    // Soften the silhouette over the last ~4% of the radius. The analytic
    // intersection is otherwise a hard binary edge and stair-steps badly, and
    // this is cheaper and more reliable than MSAA.
    '    float rr = length(pos.xy) / R;',
    '    float body = 1.0 - smoothstep(0.955, 1.0, rr);',
    '    alpha = body * (0.92 - 0.10 * uLight);',
    '    col *= alpha;',    // premultiply
    '  }',
    '',
    // Outer atmosphere. Reaches past the silhouette so the orb sits in a pool
    // of its own light rather than being die-cut out of the page.
    // Keyed off SIL (where the body actually ends), not R (a world-space
    // radius), so the glow starts exactly at the edge. Deliberately not masked
    // out from under the body: masking is what created a seam last time, and
    // under an opaque body the extra alpha is invisible anyway.
    '  float dist = length(uv);',
    // Falloff 13, not 6.5. A wide halo sounds nicer than it looks: at 6.5 this
    // still put ~4-10% alpha across a circle that nearly filled the 180px
    // canvas, which washed out the page's 4.3%-opacity dot grid over a big
    // area and read as a pale rectangle sitting behind the orb. Tight is what
    // reads as a glow; broad just reads as a smudge.
    '  float halo = exp(-max(dist - SIL, 0.0) * 13.0) * (0.30 + 0.25 * uActive);',
    // Belt and braces: force it to zero well before the canvas edge, so the
    // square backing store can never clip a visible ring.
    '  halo *= 1.0 - smoothstep(0.62, 0.92, dist);',
    '  col += uHot * halo * (1.0 - uLight * 0.30);',
    // Lighter on the cream theme, which has far less contrast headroom.
    '  alpha += halo * (0.55 + 0.15 * uLight);',
    '',
    '  alpha = clamp(alpha, 0.0, 1.0);',
    // col is premultiplied, so it must never exceed alpha or the edges glow
    // brighter than they are opaque and fringe against the page.
    '  col = min(col, vec3(alpha));',
    '  gl_FragColor = vec4(col, alpha);',
    '}',
  ].join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      // Surfaced rather than swallowed: a shader that fails to compile renders
      // nothing at all, and a silently empty canvas is very hard to diagnose.
      console.error('orb shader:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function create(canvas) {
    var gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false, // the silhouette is smoothstepped in the shader
        depth: false,
        stencil: false,
        // Required, not an optimisation knob. Without it the drawing buffer is
        // undefined after each composite, and this orb does NOT redraw every
        // frame — the watchdog in app.js falls back to ~10fps whenever rAF is
        // throttled, which is the normal case in embedded webviews. At 10 draws
        // against 60 composites the canvas would be showing an undefined buffer
        // most frames.
        preserveDrawingBuffer: true,
      });
    } catch (err) {
      return null;
    }
    if (!gl) return null;

    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('orb program:', gl.getProgramInfoLog(prog));
      return null;
    }
    gl.useProgram(prog);

    // One oversized triangle rather than two triangles: no seam down the
    // diagonal, one less vertex.
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var u = {};
    ['uAngle', 'uTime', 'uActive', 'uBurst', 'uLight', 'uBody', 'uHot'].forEach(function (name) {
      u[name] = gl.getUniformLocation(prog, name);
    });

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    var lastSize = 0;

    return {
      isGL: true,
      setSize: function (px) {
        if (lastSize === px) return;
        lastSize = px;
        canvas.width = px;
        canvas.height = px;
        gl.viewport(0, 0, px, px);
      },
      draw: function (s) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(u.uAngle, s.angle);
        gl.uniform1f(u.uTime, s.time);
        gl.uniform1f(u.uActive, s.active);
        gl.uniform1f(u.uBurst, s.burst);
        gl.uniform1f(u.uLight, s.light);
        gl.uniform3f(u.uBody, s.body[0], s.body[1], s.body[2]);
        gl.uniform3f(u.uHot, s.hot[0], s.hot[1], s.hot[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  }

  window.OrbGL = { create: create };
}());
