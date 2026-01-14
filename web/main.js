console.log("main.js loaded");

const canvas = document.getElementById("bg");
const ctx = canvas.getContext("2d", { alpha: false });
const tooltip = document.getElementById("tooltip");
const status = document.getElementById("status");

// Mouse tracking for hover detection
let mouseX = -1000; // Initialize off-screen
let mouseY = -1000;
let hoveredPlane = null;

// Verify elements exist
if (!tooltip) {
  console.error("Tooltip element not found!");
}
if (!status) {
  console.error("Status element not found!");
}

// Enable smooth rendering
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Re-enable smoothing after resize
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
}
window.addEventListener("resize", resize);
resize();

// ---- CONFIG ----
const HOME = { lat: 37.77, lon: -122.42 }; // map center: set near your receiver (rounded on purpose)
const RANGE_KM = 10; // how far out to show
const MAX_PREDICT_S = 30; // keep gliding without updates (seconds)
const STALE_REMOVE_S = 45; // remove if no update (seconds)
const PLANE_SIZE = 7;
const MIN_SPEED = 0.01; // km/s minimum speed (about 36 km/h) - ensures planes never stop

// ---- State ----
const planes = new Map(); // id -> state

// Convert degrees to radians
const toRad = (d) => d * Math.PI / 180;

// Rough local tangent-plane conversion around HOME (good for ~200km)
function latLonToLocalKm(lat, lon) {
  const lat0 = HOME.lat;
  const lon0 = HOME.lon;
  const kLat = 111.32; // km per degree latitude
  const kLon = 111.32 * Math.cos(toRad(lat0)); // km per degree longitude at lat0
  const x = (lon - lon0) * kLon;        // east (km)
  const y = (lat - lat0) * kLat;        // north (km)
  return { x, y };
}

function localKmToScreen(xKm, yKm) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const scale = Math.min(w, h) / (2 * RANGE_KM); // pixels per km
  const x = w / 2 + xKm * scale;
  const y = h / 2 - yKm * scale;
  return { x, y, scale };
}

function drawPlane(x, y, trackDeg) {
  const r = PLANE_SIZE;
  const holeRadius = r * 0.4; // Inner radius for the hole
  ctx.save();
  ctx.translate(x, y);
  // Draw donut shape: outer circle with inner circle hole
  // First draw the outer circle in black
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  // Then draw the inner circle in white to create the hole
  const oldFillStyle = ctx.fillStyle;
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.arc(0, 0, holeRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = oldFillStyle; // Restore original fill style
  ctx.restore();
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ---- WebSocket ----
const ws = new WebSocket("wss://feed.shaunaknarain.com");
ws.onopen = () => console.log("feed connected");
ws.onclose = () => console.log("feed closed");
ws.onerror = (e) => console.log("feed error", e);

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  const t = (msg.t || Date.now()) / 1000; // seconds

  for (const p of (msg.aircraft || [])) {
    if (!p.id || p.lat == null || p.lon == null) continue;

    // dump1090: track degrees, gs knots
    const track = (p.track ?? null);
    const gsKnots = (p.gs ?? null);
    const gsKmh = (gsKnots != null) ? gsKnots * 1.852 : null;

    const prev = planes.get(p.id);

    // compute local coords now
    const nowLocal = latLonToLocalKm(p.lat, p.lon);

    if (!prev) {
      // Start planes off-screen based on their velocity/direction
      let startX = nowLocal.x;
      let startY = nowLocal.y;
      
      // If we have track info, start them closer to actual position for faster appearance
      if (track != null && gsKmh != null) {
        const spd = gsKmh / 3600; // km per second
        const tr = toRad(track);
        const vx = Math.sin(tr) * spd;
        const vy = Math.cos(tr) * spd;
        // Start them closer (0.8x range) in the opposite direction of travel
        const dist = RANGE_KM * 0.8;
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed > 0.001) {
          startX = nowLocal.x - vx * (dist / speed);
          startY = nowLocal.y - vy * (dist / speed);
        } else {
          // Fallback if speed is too low
          const angle = Math.random() * Math.PI * 2;
          startX = nowLocal.x + Math.cos(angle) * dist;
          startY = nowLocal.y + Math.sin(angle) * dist;
        }
      } else {
        // Random off-screen position if no track info - closer for faster appearance
        const angle = Math.random() * Math.PI * 2;
        const dist = RANGE_KM * 0.7;
        startX = nowLocal.x + Math.cos(angle) * dist;
        startY = nowLocal.y + Math.sin(angle) * dist;
      }
      
      // Initialize velocity if we have track and speed info
      let initialVx = 0;
      let initialVy = 0;
      if (track != null && gsKmh != null) {
        const spd = gsKmh / 3600; // km per second
        const tr = toRad(track);
        initialVx = Math.sin(tr) * spd;
        initialVy = Math.cos(tr) * spd;
      }
      
      planes.set(p.id, {
        id: p.id,
        flight: p.flight ?? null,
        // "authoritative" position from feed
        feedX: nowLocal.x,
        feedY: nowLocal.y,
        feedT: t,

        // smoothed/rendered position (start off-screen)
        x: startX,
        y: startY,
        vx: initialVx,
        vy: initialVy,

        track,
        gsKmh,
        lastSeen: t,
        createdAt: t, // Track when plane was created for fade-in
      });
      continue;
    }

    // update lastSeen
    prev.lastSeen = t;
    prev.flight = p.flight ?? prev.flight;

    // estimate velocity from track+speed if available, else from delta positions
    let vx = prev.vx, vy = prev.vy;

    if (track != null && gsKmh != null) {
      const spd = Math.max(gsKmh / 3600, MIN_SPEED); // km per second, ensure minimum
      const tr = toRad(track);
      // track: 0=N, 90=E
      vx = Math.sin(tr) * spd; // east
      vy = Math.cos(tr) * spd; // north
    } else {
      const dt = t - prev.feedT;
      if (dt > 0.2) {
        vx = (nowLocal.x - prev.feedX) / dt;
        vy = (nowLocal.y - prev.feedY) / dt;
        // Ensure minimum speed
        const currentSpeed = Math.sqrt(vx * vx + vy * vy);
        if (currentSpeed < MIN_SPEED && currentSpeed > 0.001) {
          const scale = MIN_SPEED / currentSpeed;
          vx *= scale;
          vy *= scale;
        } else if (currentSpeed < 0.001) {
          // If completely stopped, use last known direction or default north
          const defaultTrack = prev.track ?? 0;
          const tr = toRad(defaultTrack);
          vx = Math.sin(tr) * MIN_SPEED;
          vy = Math.cos(tr) * MIN_SPEED;
        }
      }
    }

    prev.vx = vx;
    prev.vy = vy;

    // update authoritative feed position/time
    prev.feedX = nowLocal.x;
    prev.feedY = nowLocal.y;
    prev.feedT = t;

    prev.track = track ?? prev.track;
    prev.gsKmh = gsKmh ?? prev.gsKmh;
  }
};

// ---- Render loop ----
function frame() {
  const now = Date.now() / 1000;

  // Reset transform to identity for clearing/filling background
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  
  // Clear using canvas dimensions, not window dimensions
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Fill canvas with white background
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Restore the device pixel ratio transform for drawing planes
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  
  // Set fill style for planes
  ctx.fillStyle = "black";

  // draw faint center dot (optional). comment out if you want pure white.
  // ctx.globalAlpha = 0.15;
  // const c = localKmToScreen(0, 0);
  // ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fill();
  // ctx.globalAlpha = 1;

  for (const [id, s] of planes.entries()) {
    const age = now - s.lastSeen;

    if (age > STALE_REMOVE_S) {
      planes.delete(id);
      continue;
    }

    // Predict position forward from last feed position using velocity
    const predictS = clamp(now - s.feedT, 0, MAX_PREDICT_S);
    const targetX = s.feedX + s.vx * predictS;
    const targetY = s.feedY + s.vy * predictS;

    // Calculate distance to target
    const dx = targetX - s.x;
    const dy = targetY - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Get current velocity magnitude and direction
    let speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    
    // Ensure plane always has minimum speed to keep it moving
    if (speed < MIN_SPEED) {
      // If stopped or very slow, give it a default forward direction
      // Use last known track, or default to north (0 degrees)
      const defaultTrack = s.track ?? 0;
      const tr = toRad(defaultTrack);
      s.vx = Math.sin(tr) * MIN_SPEED;
      s.vy = Math.cos(tr) * MIN_SPEED;
      speed = MIN_SPEED;
    }
    
    // Calculate proposed movement
    let moveX = dx;
    let moveY = dy;
    
    // Cap movement speed to prevent zooming, but allow faster catch-up when far behind
    const frameTime = 1/60; // approximate frame time
    const moveDist = Math.sqrt(moveX * moveX + moveY * moveY);
    
    // Allow faster catch-up when far behind - scale cap based on distance
    const baseMaxMoveDist = speed * frameTime * 3; // Base: 3x speed
    const maxMoveDist = dist > 1.0 ? baseMaxMoveDist * (1 + dist / 2) : baseMaxMoveDist; // Scale up when far
    
    if (moveDist > maxMoveDist && maxMoveDist > 0) {
      // Scale down movement to max speed
      const scale = maxMoveDist / moveDist;
      moveX *= scale;
      moveY *= scale;
    }
    
    // Prevent backwards movement only when close to target (to avoid overshoot reversal)
    const noBackwardsThreshold = 0.5; // km - only prevent backwards when within this distance
    if (speed > 0.001 && dist < noBackwardsThreshold && dist > 0.001) {
      // Normalize velocity to get forward direction
      const forwardX = s.vx / speed;
      const forwardY = s.vy / speed;
      
      // Normalize proposed movement direction
      const finalMoveDist = Math.sqrt(moveX * moveX + moveY * moveY);
      if (finalMoveDist > 0.001) {
        const moveDirX = moveX / finalMoveDist;
        const moveDirY = moveY / finalMoveDist;
        
        // Dot product: positive = forward, negative = backward
        const dotProduct = forwardX * moveDirX + forwardY * moveDirY;
        
        // If movement would be backwards when close, only allow forward movement
        if (dotProduct < 0) {
          // Move forward at current speed instead of backwards
          moveX = forwardX * speed * frameTime;
          moveY = forwardY * speed * frameTime;
        }
      }
    }
    
    // Use dynamic smoothing - more responsive when far behind
    // Lower alpha = smoother but more lag, higher = more responsive but jittery
    const baseAlpha = 0.25; // Increased base responsiveness
    // Increase alpha when far behind to catch up faster
    const alpha = dist > 1.0 ? Math.min(baseAlpha * (1 + dist / 3), 0.6) : baseAlpha;
    
    // Ensure plane always moves forward at minimum speed
    const finalMoveDist = Math.sqrt(moveX * moveX + moveY * moveY);
    if (finalMoveDist < MIN_SPEED * frameTime * 0.5) {
      // If movement is too small, ensure forward motion at minimum speed
      const forwardX = s.vx / speed;
      const forwardY = s.vy / speed;
      moveX = forwardX * MIN_SPEED * frameTime;
      moveY = forwardY * MIN_SPEED * frameTime;
    }
    
    // Smoothly chase the target to remove jitter (never backwards when close)
    s.x += moveX * alpha;
    s.y += moveY * alpha;

    // Cull outside range (with larger buffer for fade-in effect)
    const r2 = s.x * s.x + s.y * s.y;
    if (r2 > (RANGE_KM * 1.5) ** 2) continue;

    // Fade-in effect: fade in over first 3 seconds
    const timeSinceCreation = now - (s.createdAt || now);
    const fadeIn = clamp(timeSinceCreation / 3, 0, 1);
    
    // Fade-out effect: fade out if stale (after 10 seconds)
    const fadeOut = age < 10 ? 1 : clamp(1 - (age - 10) / 20, 0, 1);
    
    // Combine fade-in and fade-out
    ctx.globalAlpha = fadeIn * fadeOut;

    const { x, y } = localKmToScreen(s.x, s.y);
    // Store screen position for hover detection (only for visible planes)
    s.screenX = x;
    s.screenY = y;
    drawPlane(x, y, s.track);
  }

  ctx.globalAlpha = 1;
  
  // Check for hover after rendering
  checkHover();
  
  // Update status display
  updateStatus();
  
  requestAnimationFrame(frame);
}

// Update status display with time and aircraft count
function updateStatus() {
  if (!status) return;
  
  // Format current time
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  
  // Get aircraft count
  const aircraftCount = planes.size;
  
  // Update status display
  status.textContent = `${timeStr}\n${aircraftCount} aircraft`;
}

// Hover detection
function checkHover() {
  // Don't check if mouse is off-screen
  if (mouseX < 0 || mouseY < 0) {
    tooltip.style.display = "none";
    return;
  }
  
  const hoverRadius = PLANE_SIZE * 4; // Hover radius around plane (in CSS pixels)
  let closestPlane = null;
  let closestDist = Infinity;
  
  // screenX/screenY are in CSS pixels (from localKmToScreen), mouseX/mouseY are also in CSS pixels
  for (const [id, s] of planes.entries()) {
    if (s.screenX == null || s.screenY == null) continue;
    
    const dx = mouseX - s.screenX;
    const dy = mouseY - s.screenY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < hoverRadius && dist < closestDist) {
      closestDist = dist;
      closestPlane = s;
    }
  }
  
  if (closestPlane) {
    hoveredPlane = closestPlane;
    // Show flight number if available, otherwise show plane ID
    const displayText = closestPlane.flight || `ID: ${closestPlane.id}`;
    tooltip.textContent = displayText;
    tooltip.style.display = "block";
    tooltip.style.left = mouseX + 15 + "px";
    tooltip.style.top = mouseY + 15 + "px";
  } else {
    hoveredPlane = null;
    tooltip.style.display = "none";
  }
}

// Mouse move handler
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
  // Debug: uncomment to see mouse coordinates
  // console.log("Mouse:", mouseX, mouseY, "Planes:", planes.size);
});

canvas.addEventListener("mouseleave", () => {
  mouseX = -1000; // Move off-screen
  mouseY = -1000;
  hoveredPlane = null;
  tooltip.style.display = "none";
});

requestAnimationFrame(frame);