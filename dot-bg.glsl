/** @resolution */
uniform vec2 u_resolution;

/**
 * @label Dot Spacing
 * @range 8, 48
 * @default 22
 */
uniform float u_spacing;

/**
 * @label Dot Radius
 * @range 0.5, 3
 * @default 1.2
 */
uniform float u_radius;

/**
 * @label Background
 * @color
 * @default #FAFAF9
 */
uniform vec3 u_bg;

/**
 * @label Dot Color
 * @color
 * @default #D5D5D0
 */
uniform vec3 u_dot;

void main() {
  vec2 p = gl_FragCoord.xy;

  // Distance to the nearest dot center in a uniform grid.
  vec2 cell = mod(p, u_spacing) - u_spacing * 0.5;
  float d = length(cell);
  float dotMask = 1.0 - smoothstep(u_radius - 0.5, u_radius + 0.5, d);

  // Radial fade: strongest at the center, fading toward the edges.
  vec2 uv = p / u_resolution - 0.5;
  uv.x *= u_resolution.x / u_resolution.y;
  float fade = 1.0 - smoothstep(0.1, 0.7, length(uv));
  float alpha = dotMask * fade;

  vec3 color = mix(u_bg, u_dot, alpha);
  gl_FragColor = vec4(color, 1.0);
}
