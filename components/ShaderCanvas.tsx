"use client";

import { useEffect, useRef } from "react";
import { SHADERS, VERTEX, type ShaderId } from "@/lib/shaders";

type Props = {
  shader: ShaderId;
  colors: [string, string, string];
  speed?: number;
  className?: string;
};

/** Degrees of tilt from the resting position that sweep the full width/height. */
const TILT_RANGE = 30;
/** How far the pointer / tilt can push u_mouse from the centre (0.5 = full range). */
const REACH = 0.18;
const toMouse = (v: number) => 0.5 + (clamp01(v) - 0.5) * 2 * REACH;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type OrientationPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

const hexToRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as const;
};

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(s));
  }
  return s;
}

export default function ShaderCanvas({ shader, colors, speed = 1, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Live values read inside the render loop without restarting it.
  const live = useRef({ colors, speed });
  const repaint = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) return;

    gl.getExtension("OES_standard_derivatives");
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, SHADERS[shader].frag));
    gl.linkProgram(program);
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uRes = u("u_res"), uTime = u("u_time"), uMouse = u("u_mouse");
    const uC = [u("u_c1"), u("u_c2"), u("u_c3")];

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    let time = 7.3;
    let last = performance.now();
    let raf = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      time += dt * live.current.speed;
      mouse.x += (mouse.tx - mouse.x) * 0.03;
      mouse.y += (mouse.ty - mouse.y) * 0.03;
      resize();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, time);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      live.current.colors.forEach((c, i) => gl.uniform3fv(uC[i], hexToRgb(c)));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // Fade in over the parent's CSS fallback once there is a real frame.
      canvas.style.opacity = "1";
      if (!reduced) raf = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent) => {
      // Touch drags are scrolls; on phones only the tilt sensor moves the shader.
      if (e.pointerType !== "mouse") return;
      const r = canvas.getBoundingClientRect();
      mouse.tx = toMouse((e.clientX - r.left) / r.width);
      mouse.ty = toMouse(1 - (e.clientY - r.top) / r.height);
    };
    // Phones: tilt drives the same uniform as the mouse, relative to how the phone is held.
    let rest: { beta: number; gamma: number } | null = null;
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      rest ??= { beta: e.beta, gamma: e.gamma };
      // Slowly re-centre so a new grip becomes the neutral position.
      rest.beta += (e.beta - rest.beta) * 0.0008;
      rest.gamma += (e.gamma - rest.gamma) * 0.0008;
      let dx = e.gamma - rest.gamma;
      let dy = rest.beta - e.beta;
      const angle = screen.orientation?.angle ?? 0;
      if (angle === 90) [dx, dy] = [-dy, dx];
      else if (angle === 270) [dx, dy] = [dy, -dx];
      mouse.tx = toMouse(0.5 + dx / (2 * TILT_RANGE));
      mouse.ty = toMouse(0.5 + dy / (2 * TILT_RANGE));
    };
    const onRotate = () => (rest = null);
    const listenTilt = () => window.addEventListener("deviceorientation", onOrient);
    // iOS only grants motion access from a user gesture, so ask on the first tap.
    const askTilt = () => {
      (DeviceOrientationEvent as unknown as OrientationPermission)
        .requestPermission?.()
        .then((state) => state === "granted" && listenTilt())
        .catch(() => {});
    };
    const touch = window.matchMedia("(pointer: coarse)").matches && "DeviceOrientationEvent" in window;
    if (touch && !reduced) {
      if (typeof (DeviceOrientationEvent as unknown as OrientationPermission).requestPermission === "function") {
        window.addEventListener("pointerdown", askTilt, { once: true });
      } else {
        listenTilt();
      }
      screen.orientation?.addEventListener("change", onRotate);
    }

    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(draw);
      }
    };
    repaint.current = () => {
      if (reduced) requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(() => repaint.current());
    ro.observe(canvas);

    window.addEventListener("pointermove", onMove);
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", askTilt);
      window.removeEventListener("deviceorientation", onOrient);
      screen.orientation?.removeEventListener("change", onRotate);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteProgram(program);
      gl.deleteBuffer(buf);
    };
  }, [shader]);

  // Reduced-motion users get a static frame; repaint it when colours change.
  useEffect(() => {
    live.current = { colors, speed };
    repaint.current();
  }, [colors, speed]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{ opacity: 0, transition: "opacity 500ms ease-out" }}
    />
  );
}
