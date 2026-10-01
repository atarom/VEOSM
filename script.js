import * as maplibregl from "https://unpkg.com/maplibre-gl@6.11.1/dist/maplibre-gl.mjs";
const $ = (s) => document.querySelector(s);
const PP = "https://postpass.geofabrik.de/api/0.2/interpreter";
const STYLE = "https://tiles.openfreemap.org/styles/fiord";
const SRC = "veosm-points";
const LYR = "veosm-points-layer";
const EMPTY = { type: "FeatureCollection", features: [] };
const CACHE_MS = 60000;
const CACHE = { nominatim: null, engine: null };
const INFLIGHT = { nominatim: null, engine: null };
const OPS = [
  ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "maps.mail.ru"],
  ["https://overpass-api.de/api/interpreter", "overpass-api.de"]
];
const S = {
  map: null,
  ready: false,
  items: [],
  groups: [],
  sel: null,
  bounds: null,
  locked: false,
  key: "fixme",
  multi: false,
  area: "–",
  engine: "postpass",
  op: OPS[0][0],
  popup: null
};
let timer, closeTimer, cacheFrame, searching = false;
const store = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {}
};
const querySignature = () =>
  [
    $("#query")?.value.trim() || "",
    $("#key")?.value.trim() || "",
    S.engine,
    S.engine === "overpass" ? S.op : ""
  ].join("|");
const resetSearchButton = () => {
  const button = $(".search-btn");
  if (!button) return;
  button.disabled = false;
  button.textContent = "Search";
  button.style.removeProperty("background");
  button.style.removeProperty("color");
  button.style.removeProperty("text-shadow");
  button.style.removeProperty("opacity");
};
const cancelCacheWait = (clearNominatim = false) => {
  if (cacheFrame) {
    cancelAnimationFrame(cacheFrame);
    cacheFrame = null;
  }
  CACHE.engine = null;
  if (clearNominatim) CACHE.nominatim = null;
  if (!searching) resetSearchButton();
};
const cacheButton = (signature) => {
  const button = $(".search-btn");
  if (!button) return;
  if (cacheFrame) cancelAnimationFrame(cacheFrame);
  const tick = () => {
    if (querySignature() !== signature) {
      cacheFrame = null;
      CACHE.engine = null;
      resetSearchButton();
      return;
    }
    const hit = CACHE.engine;
    const remaining = hit ? CACHE_MS - (Date.now() - hit.time) : 0;
    if (remaining <= 0) {
      cacheFrame = null;
      resetSearchButton();
      return;
    }
    const pct = Math.max(0, Math.min(100, (remaining / CACHE_MS) * 100));
    button.disabled = true;
    button.textContent = `Search · ${Math.ceil(remaining / 1000)}s`;
    button.style.background = `linear-gradient(90deg,#c4ad78 0%,#c4ad78 ${pct}%,#25291e ${pct}%,#11140f 100%)`;
    button.style.color = "#f0e2bb";
    button.style.textShadow = "0 1px 2px #000";
    button.style.opacity = "1";
    cacheFrame = requestAnimationFrame(tick);
  };
  tick();
};
const cached = async (scope, key, task, label) => {
  const hit = CACHE[scope];
  if (hit && hit.key === key && Date.now() - hit.time < CACHE_MS) {
    log(`60 s cache: ${label}.`);
    return hit.data;
  }
  const pending = INFLIGHT[scope];
  if (pending && pending.key === key) {
    log(`Identical query already in progress: ${label}.`);
    return pending.promise;
  }
  const request = task()
    .then((data) => {
      CACHE[scope] = { key, time: Date.now(), data };
      return data;
    })
    .finally(() => {
      if (INFLIGHT[scope]?.promise === request) INFLIGHT[scope] = null;
    });
  INFLIGHT[scope] = { key, promise: request };
  return request;
};
const log = (m) => {
  const e = $("#overlay-log");
  if (!e) return;
  e.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
  e.scrollTop = e.scrollHeight;
};
const overlay = (msg, close = false) => {
  const e = $("#overlay");
  if (!e) return;
  clearTimeout(timer);
  clearTimeout(closeTimer);
  if (close) {
    e.classList.add("closing");
    closeTimer = setTimeout(() => {
      e.hidden = true;
      e.classList.remove("closing");
    }, 350);
    return;
  }
  e.hidden = false;
  e.classList.remove("closing");
  $("#overlay-log").textContent = "";
  if (msg) log(msg);
};
const success = () => {
  timer = setTimeout(() => overlay(null, true), 1200);
};
async function json(url, options = {}, timeout = 70000, label = "Request") {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { ...options, signal: c.signal });
    if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${label}: timed out`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}
const uiEngine = () => {
  $("#query-engine").value = S.engine;
  $("#overpass-config").hidden = S.engine !== "overpass";
};
const stats = (n = 0, g = 0, area = "–", key = S.key) => {
  S.key = key;
  S.area = area;
  $("#stat-elements").textContent = n;
  $("#stat-groups").textContent = g;
  $("#stat-area").textContent = area;
  $("#stat-key").textContent = key;
  $("#groups-header-key").textContent = `Value of "${key}"`;
};
const closePopup = () => {
  if (!S.popup) return;
  const p = S.popup;
  S.popup = null;
  p.remove();
};
const fit = (b) => {
  if (S.map && S.ready && b && !b.isEmpty() && !S.locked) {
    S.map.fitBounds(b, { padding: 40, maxZoom: 17, duration: 500 });
  }
};
const renderGroups = () => {
  const list = $("#groups-list");
  list.replaceChildren();
  if (!S.groups.length) {
    list.innerHTML = '<div class="empty-state">No results yet. Search for an area using the specified key.</div>';
    return;
  }
  S.groups.forEach((g, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `group-item${S.sel === i ? " active" : ""}`;
    b.innerHTML = `<div class="group-main"><div class="group-title"></div></div><div class="group-count">${g.count}</div>`;
    b.querySelector(".group-title").textContent = g.value;
    b.onclick = () => {
      S.sel = S.sel === i ? null : i;
      renderGroups();
      renderPoints();
      closePopup();
      if (S.sel === null) return fit(S.bounds);
      const bounds = new maplibregl.LngLatBounds();
      S.groups[S.sel].elements.forEach((x) => {
        const e = S.items[x];
        bounds.extend([e.lon, e.lat]);
      });
      fit(bounds);
    };
    list.appendChild(b);
  });
};
const fc = () => ({
  type: "FeatureCollection",
  features:
    S.sel === null
      ? []
      : S.groups[S.sel].elements.map((index) => {
          const e = S.items[index];
          return {
            type: "Feature",
            properties: { index },
            geometry: { type: "Point", coordinates: [e.lon, e.lat] }
          };
        })
});
const renderPoints = () => {
  if (S.ready) S.map.getSource(SRC)?.setData(fc());
};
const popup = (e) => {
  const root = document.createElement("div");
  const title = document.createElement("div");
  const sub = document.createElement("div");
  const tags = document.createElement("div");
  const table = document.createElement("div");
  const actions = document.createElement("div");
  root.className = "popup";
  title.className = "popup-title";
  title.textContent = e.value;
  sub.className = "popup-subtitle";
  sub.textContent = `${e.type} ${e.id}${e.tags.name ? ` · ${e.tags.name}` : ""}`;
  tags.className = "popup-tags";
  table.className = "popup-tags-table";
  Object.keys(e.tags)
    .sort()
    .forEach((k) => {
      const row = document.createElement("div");
      const a = document.createElement("span");
      const b = document.createElement("span");
      row.className = "popup-tags-row";
      a.className = "popup-tag-key";
      b.className = "popup-tag-value";
      a.textContent = k;
      b.textContent = e.tags[k];
      row.append(a, b);
      table.appendChild(row);
    });
  tags.appendChild(table);
  actions.className = "popup-actions";
  [
    ["View on OpenStreetMap", e.url],
    ["Edit with iD", `https://www.openstreetmap.org/edit?${e.type}=${e.id}`]
  ].forEach(([title, url]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.onclick = () => window.open(url, "_blank", "noopener,noreferrer");
    actions.appendChild(b);
  });
  root.append(title, sub, tags, actions);
  return root;
};
const group = () => {
  const m = new Map();
  const used = new Set();
  S.items.forEach((e, i) => {
    if (!S.multi) {
      if (!m.has(e.value)) m.set(e.value, new Set());
      m.get(e.value).add(i);
      used.add(i);
      return;
    }
    const values = e.value
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length < 2) return;
    used.add(i);
    new Set(values).forEach((v) => {
      if (!m.has(v)) m.set(v, new Set());
      m.get(v).add(i);
    });
  });
  S.groups = [...m]
    .map(([value, set]) => ({ value, count: set.size, elements: [...set] }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  S.sel = null;
  closePopup();
  renderGroups();
  renderPoints();
  stats(used.size, S.groups.length, S.area, S.key);
};
const area = async (name) => {
  log("Querying Nominatim...");
  const data = await cached(
    "nominatim",
    `nominatim|${name.toLowerCase()}`,
    () =>
      json(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(name)}&limit=5`,
        { headers: { Accept: "application/json" } },
        30000,
        "Nominatim"
      ),
    `Nominatim · ${name}`
  );
  return data.find((x) => x.osm_type === "relation") || null;
};
const postpassSQL = (id, key) => {
  const safeId = Number(id);
  if (!Number.isInteger(safeId)) throw new Error("Invalid relation id");
  const safeKey = String(key).replace(/'/g, "''");
  return `WITH area AS MATERIALIZED (
  SELECT geom
  FROM postpass_polygon
  WHERE osm_type = 'R'
    AND osm_id = ${safeId}
)
SELECT
  o.tags,
  ST_PointOnSurface(o.geom) AS geom,
  o.osm_type,
  o.osm_id,
  'https://osm.org/' ||
    CASE o.osm_type
      WHEN 'N' THEN 'node'
      WHEN 'W' THEN 'way'
      WHEN 'R' THEN 'relation'
    END || '/' || o.osm_id AS osm_url
FROM area a
CROSS JOIN LATERAL (
  SELECT
    p.tags,
    p.geom,
    p.osm_type,
    p.osm_id
  FROM postpass_pointlinepolygon p
  WHERE p.tags ? '${safeKey}'
    AND ST_Intersects(p.geom, a.geom)
) o`;
};
const fetchPostpass = async (id, key) => {
  log("Engine: Postpass");
  const data = await cached(
    "engine",
    `postpass|${PP}|${id}|${key}`,
    () =>
      json(
        `${PP}?data=${encodeURIComponent(postpassSQL(id, key))}`,
        { headers: { Accept: "application/geo+json,application/json" } },
        70000,
        "Postpass"
      ),
    `Postpass · relation ${id} · ${key}`
  );
  log(`Elements received: ${data.features?.length || 0}`);
  return data;
};
const fetchOverpass = async (id, key, op) => {
  const server = OPS.find((x) => x[0] === op) || OPS[0];
  const k = String(key).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const q = `[out:json][timeout:64][maxsize:128Mi];rel(${id});map_to_area->.a;nwr["${k}"](area.a);out center;`;
  log(`Engine: Overpass · ${server[1]}`);
  const data = await cached(
    "engine",
    `overpass|${server[0]}|${id}|${key}`,
    () =>
      json(
        server[0],
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
          },
          body: `data=${encodeURIComponent(q)}`
        },
        70000,
        "Overpass"
      ),
    `Overpass · ${server[1]} · relation ${id} · ${key}`
  );
  log(`Elements received: ${data.elements?.length || 0}`);
  return data;
};
const process = (data, key, engine) => {
  const bounds = new maplibregl.LngLatBounds();
  const out = [];
  const add = (id, type, lat, lon, tags, url) => {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      typeof tags?.[key] !== "string"
    ) {
      return;
    }
    out.push({ id, type, lat, lon, tags, url, value: tags[key] });
    bounds.extend([lon, lat]);
  };
  if (engine === "postpass") {
    (data.features || []).forEach((f) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates || [];
      const t = { N: "node", W: "way", R: "relation" }[p.osm_type];
      if (t) {
        add(
          Number(p.osm_id),
          t,
          Number(c[1]),
          Number(c[0]),
          p.tags || {},
          p.osm_url || `https://osm.org/${t}/${p.osm_id}`
        );
      }
    });
  } else {
    (data.elements || []).forEach((e) => {
      const t = e.type;
      const lat = t === "node" ? e.lat : e.center?.lat;
      const lon = t === "node" ? e.lon : e.center?.lon;
      add(e.id, t, lat, lon, e.tags || {}, `https://osm.org/${t}/${e.id}`);
    });
  }
  return { items: out, bounds };
};
const clear = () => {
  S.items = [];
  S.groups = [];
  S.sel = null;
  S.bounds = null;
  closePopup();
  renderGroups();
  renderPoints();
  stats(0, 0, "–", S.key);
};
const search = async () => {
  const name = $("#query").value.trim();
  const key = $("#key").value.trim();
  const button = $(".search-btn");
  const engine = S.engine;
  const op = S.op;
  const signature = [
    name,
    key,
    engine,
    engine === "overpass" ? op : ""
  ].join("|");
  if (!name || !key) return overlay("Enter an area and key.");
  S.key = key;
  S.multi = $("#multi-toggle").checked;
  searching = true;
  button.disabled = true;
  button.textContent = "Searching…";
  button.style.removeProperty("background");
  button.style.removeProperty("color");
  button.style.removeProperty("text-shadow");
  button.style.removeProperty("opacity");
  try {
    overlay("Starting search...");
    clear();
    log(`Area: ${name}`);
    log(`Key: ${key}`);
    log(`Engine: ${engine}`);
    const a = await area(name);
    if (querySignature() !== signature) return;
    if (!a) {
      log("No OSM relation was found for that area.");
      return;
    }
    S.area = a.display_name || name;
    log(`Relation: ${a.osm_id}`);
    const data =
      engine === "postpass"
        ? await fetchPostpass(a.osm_id, key)
        : await fetchOverpass(a.osm_id, key, op);
    if (querySignature() !== signature) return;
    const p = process(data, key, engine);
    S.items = p.items;
    S.bounds = p.bounds.isEmpty() ? null : p.bounds;
    group();
    if (S.bounds) fit(S.bounds);
    log(
      S.items.length
        ? "Process completed successfully."
        : "Process completed with no results."
    );
    success();
  } catch (e) {
    log(`Error: ${e.message || e}`);
  } finally {
    searching = false;
    if (querySignature() !== signature) {
      CACHE.engine = null;
      resetSearchButton();
      return;
    }
    const hit = CACHE.engine;
    if (hit && Date.now() - hit.time < CACHE_MS) {
      cacheButton(signature);
    } else {
      resetSearchButton();
    }
  }
};
const zoomControl = () =>
  new (class {
    onAdd() {
      this.el = document.createElement("div");
      this.el.className = "maplibregl-ctrl maplibregl-ctrl-group zoom-lock-control";
      const b = document.createElement("button");
      const draw = () => {
        b.classList.toggle("active", S.locked);
        b.title = S.locked ? "Unlock auto-zoom" : "Lock auto-zoom";
        b.setAttribute("aria-label", b.title);
      };
      b.className = "zoom-lock-btn";
      b.type = "button";
      b.onclick = () => {
        S.locked = !S.locked;
        draw();
      };
      draw();
      this.el.appendChild(b);
      return this.el;
    }
    onRemove() {
      this.el.remove();
    }
  })();
const initMap = () => {
  S.map = new maplibregl.Map({
    container: "map",
    style: STYLE,
    center: [0, 40],
    zoom: 5,
    minZoom: 4,
    maxZoom: 19,
    attributionControl: false
  });
  S.map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "top-left"
  );
  S.map.addControl(
    new maplibregl.AttributionControl({ compact: true }),
    "bottom-right"
  );
  S.map.addControl(zoomControl(), "top-right");
  S.map.once("load", () => {
    S.ready = true;
    S.map.addSource(SRC, { type: "geojson", data: EMPTY });
    S.map.addLayer({
      id: LYR,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": 6,
        "circle-color": "#c4ad78",
        "circle-opacity": 0.94,
        "circle-stroke-color": "#171a12",
        "circle-stroke-width": 2
      }
    });
    S.map.on("mouseenter", LYR, () => {
      S.map.getCanvas().style.cursor = "pointer";
    });
    S.map.on("mouseleave", LYR, () => {
      S.map.getCanvas().style.cursor = "";
    });
    S.map.on("click", LYR, (ev) => {
      const i = Number(ev.features?.[0]?.properties?.index);
      const e = S.items[i];
      if (!e) return;
      closePopup();
      const p = new maplibregl.Popup({ offset: 10, maxWidth: "370px" })
        .setLngLat([e.lon, e.lat])
        .setDOMContent(popup(e))
        .addTo(S.map);
      S.popup = p;
      p.on("close", () => {
        if (S.popup === p) S.popup = null;
      });
    });
    S.map.on("click", (ev) => {
      if (!S.map.queryRenderedFeatures(ev.point, { layers: [LYR] }).length) {
        closePopup();
      }
    });
    renderPoints();
    S.map.once("idle", () => {
      $("#map").classList.add("map-ready");
    });
  });
};
const restore = () => {
  const eng = store("veosm_engine");
  const op = store("veosm_overpass");
  const multi = store("veosm_multi");
  if (["postpass", "overpass"].includes(eng)) S.engine = eng;
  if (OPS.some((x) => x[0] === op)) S.op = op;
  if (multi !== null) S.multi = multi === "true";
  $("#overpass-server").value = S.op;
  $("#multi-toggle").checked = S.multi;
  uiEngine();
};
const init = () => {
  restore();
  stats();
  initMap();
  $("#search-form").onsubmit = (e) => {
    e.preventDefault();
    search();
  };
  $("#overlay-close").onclick = () => {
    overlay(null, true);
  };
  $("#query").oninput = () => {
    cancelCacheWait(true);
  };
  $("#key").oninput = () => {
    cancelCacheWait();
  };
  $("#query-engine").onchange = (e) => {
    S.engine = e.target.value;
    store("veosm_engine", S.engine);
    cancelCacheWait();
    uiEngine();
  };
  $("#overpass-server").onchange = (e) => {
    S.op = e.target.value;
    store("veosm_overpass", S.op);
    cancelCacheWait();
  };
  $("#multi-toggle").onchange = (e) => {
    S.multi = e.target.checked;
    store("veosm_multi", S.multi);
    if (S.items.length) group();
  };
};
init();
