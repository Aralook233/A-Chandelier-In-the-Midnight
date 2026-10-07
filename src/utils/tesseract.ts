import { onThemeChange } from './theme';

type Point3 = [number, number, number];
type Point4 = [number, number, number, number];
type ScreenPoint = { x: number; y: number; z: number };
type Palette = {
  shell: string;
  shellSoft: string;
  core: string;
  label: string;
  edgeRgb: string;
};

function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    shell: token('--canvas-shell', 'rgba(112, 170, 220, 0.28)'),
    shellSoft: token('--canvas-shell-soft', 'rgba(112, 170, 220, 0.18)'),
    core: token('--canvas-core', 'rgba(33, 30, 26, 0.82)'),
    label: token('--canvas-label', 'rgba(40, 34, 28, 0.9)'),
    edgeRgb: token('--canvas-edge-rgb', '38, 30, 22'),
  };
}

function buildTesseract(): { vertices: Point4[]; edges: [number, number][] } {
  const vertices: Point4[] = [];
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        for (let w = 0; w < 2; w += 1) {
          vertices.push([
            x === 0 ? -1 : 1,
            y === 0 ? -1 : 1,
            z === 0 ? -1 : 1,
            w === 0 ? -1 : 1,
          ]);
        }
      }
    }
  }

  const edges: [number, number][] = [];
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      let diffCount = 0;
      for (let axis = 0; axis < 4; axis += 1) {
        if (vertices[i][axis] !== vertices[j][axis]) diffCount += 1;
      }
      if (diffCount === 1) edges.push([i, j]);
    }
  }

  return { vertices, edges };
}

const truncatedOctahedronVertices: Point3[] = [
  [2, 1, 0], [2, -1, 0], [-2, 1, 0], [-2, -1, 0],
  [2, 0, 1], [2, 0, -1], [-2, 0, 1], [-2, 0, -1],
  [1, 2, 0], [1, -2, 0], [-1, 2, 0], [-1, -2, 0],
  [1, 0, 2], [1, 0, -2], [-1, 0, 2], [-1, 0, -2],
  [0, 2, 1], [0, 2, -1], [0, -2, 1], [0, -2, -1],
  [0, 1, 2], [0, 1, -2], [0, -1, 2], [0, -1, -2],
];

function buildOctahedronEdges(): [number, number][] {
  const edges: [number, number][] = [];
  const expectedEdgeLength = Math.SQRT2;
  for (let i = 0; i < truncatedOctahedronVertices.length; i += 1) {
    for (let j = i + 1; j < truncatedOctahedronVertices.length; j += 1) {
      const a = truncatedOctahedronVertices[i];
      const b = truncatedOctahedronVertices[j];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (Math.abs(distance - expectedEdgeLength) < 0.16) edges.push([i, j]);
    }
  }
  return edges;
}

function buildShellLines(): { latitudes: Point3[][]; longitudes: Point3[][] } {
  const latitudes: Point3[][] = [];
  const longitudes: Point3[][] = [];
  const radius = 9.6;

  for (let latIndex = 0; latIndex <= 10; latIndex += 1) {
    const lat = -Math.PI / 2 + (Math.PI * latIndex) / 10;
    const ring: Point3[] = [];
    for (let lonIndex = 0; lonIndex <= 30; lonIndex += 1) {
      const lon = (Math.PI * 2 * lonIndex) / 30;
      ring.push([
        radius * Math.cos(lat) * Math.cos(lon),
        radius * Math.sin(lat),
        radius * Math.cos(lat) * Math.sin(lon),
      ]);
    }
    latitudes.push(ring);
  }

  for (let lonIndex = 0; lonIndex <= 20; lonIndex += 1) {
    const lon = (Math.PI * 2 * lonIndex) / 20;
    const meridian: Point3[] = [];
    for (let latIndex = 0; latIndex <= 12; latIndex += 1) {
      const lat = -Math.PI / 2 + (Math.PI * latIndex) / 12;
      meridian.push([
        radius * Math.cos(lat) * Math.cos(lon),
        radius * Math.sin(lat),
        radius * Math.cos(lat) * Math.sin(lon),
      ]);
    }
    longitudes.push(meridian);
  }

  return { latitudes, longitudes };
}

function rotate3D(point: Point3, rx: number, ry: number, rz: number): Point3 {
  let [x, y, z] = point;

  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const y1 = y * cosX - z * sinX;
  const z1 = y * sinX + z * cosX;
  y = y1;
  z = z1;

  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const x2 = x * cosY + z * sinY;
  const z2 = -x * sinY + z * cosY;
  x = x2;
  z = z2;

  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);
  return [x * cosZ - y * sinZ, x * sinZ + y * cosZ, z];
}

function project3D(
  point: Point3,
  scale: number,
  center: [number, number],
  cameraDistance: number
): ScreenPoint {
  const [x, y, z] = point;
  const perspective = 1 / (cameraDistance - z);
  return {
    x: center[0] + x * scale * perspective,
    y: center[1] + y * scale * perspective,
    z,
  };
}

function rotateIn4D(point: Point4, time: number): Point4 {
  let [x, y, z, w] = point;

  const rotate = (aIndex: number, bIndex: number, angle: number) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const coords = [x, y, z, w];
    const a = coords[aIndex];
    const b = coords[bIndex];
    coords[aIndex] = a * cos - b * sin;
    coords[bIndex] = a * sin + b * cos;
    [x, y, z, w] = coords as Point4;
  };

  rotate(0, 1, time * 0.7);
  rotate(0, 2, time * 0.9);
  rotate(0, 3, time * 1.1);
  rotate(1, 2, time * 0.6);
  rotate(1, 3, time * 1.3);
  rotate(2, 3, time * 0.8);

  return [x, y, z, w];
}

function projectToScreen(point: Point4, width: number, height: number, time: number): ScreenPoint {
  const [x, y, z, w] = rotateIn4D(point, time);
  const cameraDistance = 3.2;
  const perspective = 1 / (cameraDistance - w);
  const px = x * perspective;
  const py = y * perspective;
  const pz = z * perspective;

  const yaw = time * 0.85;
  const pitch = time * 0.65;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);

  const x1 = px * cy - pz * sy;
  const z1 = px * sy + pz * cy;
  const y1 = py * cx - z1 * sx;
  const z2 = py * sx + z1 * cx;

  const scale = Math.min(width, height) * 0.27;
  return {
    x: x1 * scale + width * 0.5,
    y: y1 * scale + height * 0.5,
    z: z2,
  };
}

export function mountTesseract(canvas: Element | null): void {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const context = canvas.getContext('2d');
  const stage = canvas.parentElement;
  if (!context || !stage) return;

  const palette = readPalette();
  onThemeChange(() => Object.assign(palette, readPalette()));

  const { vertices, edges } = buildTesseract();
  const octahedronEdges = buildOctahedronEdges();
  const { latitudes: shellLatitudeLines, longitudes: shellLongitudeLines } = buildShellLines();

  function resizeCanvas() {
    const rect = stage!.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas!.width = Math.max(1, rect.width * ratio);
    canvas!.height = Math.max(1, rect.height * ratio);
    context!.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function strokePolyline(points: ScreenPoint[], strokeStyle: string) {
    context!.beginPath();
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (index === 0) context!.moveTo(point.x, point.y);
      else context!.lineTo(point.x, point.y);
    }
    context!.strokeStyle = strokeStyle;
    context!.stroke();
  }

  function drawShell(width: number, height: number, time: number) {
    const center: [number, number] = [width * 0.5, height * 0.52];
    const scale = Math.min(width, height) * 0.29;
    const rotationY = time * 0.72;

    for (const ring of shellLatitudeLines) {
      strokePolyline(
        ring.map((point) => project3D(rotate3D(point, 0.18, rotationY, 0.04), scale, center, 15.2)),
        palette.shell
      );
    }

    for (const meridian of shellLongitudeLines) {
      strokePolyline(
        meridian.map((point) => project3D(rotate3D(point, 0.18, rotationY, 0.04), scale, center, 15.2)),
        palette.shellSoft
      );
    }
  }

  function drawTruncatedOctahedron(width: number, height: number, time: number) {
    const center: [number, number] = [width * 0.5, height * 0.52];
    const scale = Math.min(width, height) * 0.16;
    const rotation = time * 0.8;
    const projected = truncatedOctahedronVertices.map((point) =>
      project3D(rotate3D(point, rotation, rotation * 0.7, rotation * 0.4), scale, center, 6.2)
    );

    const sortedEdges = octahedronEdges
      .map(([start, end]) => ({
        start: projected[start],
        end: projected[end],
        depth: (projected[start].z + projected[end].z) * 0.5,
      }))
      .sort((a, b) => b.depth - a.depth);

    context!.strokeStyle = palette.core;
    for (const edge of sortedEdges) {
      context!.beginPath();
      context!.moveTo(edge.start.x, edge.start.y);
      context!.lineTo(edge.end.x, edge.end.y);
      context!.stroke();
    }

    context!.font = 'italic 18px Georgia, serif';
    context!.fillStyle = palette.label;
    context!.fillText('i', center[0] + 36, center[1] - 20);
  }

  function draw(now: number) {
    const width = stage!.clientWidth;
    const height = stage!.clientHeight;
    const time = now * 0.001;

    context!.clearRect(0, 0, width, height);
    context!.lineWidth = 1.2;
    context!.lineCap = 'round';
    context!.lineJoin = 'round';

    drawShell(width, height, time);

    const projected = vertices.map((vertex) => projectToScreen(vertex, width, height, time));
    const sortedEdges = edges
      .map(([startIndex, endIndex]) => {
        const a = projected[startIndex];
        const b = projected[endIndex];
        return { start: a, end: b, depth: (a.z + b.z) * 0.5 };
      })
      .sort((edgeA, edgeB) => edgeB.depth - edgeA.depth);

    for (const edge of sortedEdges) {
      const alpha = 0.2 + ((edge.depth + 4) / 12) * 0.8;
      context!.strokeStyle = `rgba(${palette.edgeRgb}, ${Math.min(Math.max(alpha, 0.22), 0.95)})`;
      context!.beginPath();
      context!.moveTo(edge.start.x, edge.start.y);
      context!.lineTo(edge.end.x, edge.end.y);
      context!.stroke();
    }

    drawTruncatedOctahedron(width, height, time);
  }

  // The canvas only needs frames while someone can actually see it: a hidden tab
  // would otherwise burn a full 3D redraw sixty times a second forever.
  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let onScreen = true;
  let animating = false;
  let frameQueued = 0;

  function wantsFrames() {
    return onScreen && !document.hidden && !motionQuery?.matches;
  }

  function tick(now: number) {
    frameQueued = 0;
    draw(now);
    if (wantsFrames()) frameQueued = requestAnimationFrame(tick);
    else animating = false;
  }

  function play() {
    if (animating || !wantsFrames()) return;
    animating = true;
    frameQueued = requestAnimationFrame(tick);
  }

  function pause() {
    if (frameQueued) cancelAnimationFrame(frameQueued);
    frameQueued = 0;
    animating = false;
  }

  let resizeTimer = 0;
  function onResize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeCanvas();
      // Resizing clears the bitmap, so a paused canvas still needs one repaint.
      if (!animating) draw(performance.now());
    }, 120);
  }

  resizeCanvas();
  if (motionQuery?.matches) draw(0);
  else play();

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      if (onScreen) play();
      else pause();
    });
    observer.observe(stage);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else play();
  });
  motionQuery?.addEventListener?.('change', () => {
    if (motionQuery.matches) {
      pause();
      draw(performance.now());
    } else {
      play();
    }
  });
  window.addEventListener('resize', onResize);
}
