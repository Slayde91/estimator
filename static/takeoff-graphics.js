"use strict";

// PDF-only marks use literal text and bounded numeric geometry. No supplied SVG,
// HTML, URLs or image bytes enter this renderer.
(function (root) {
  const kinds = Object.freeze(["cloud", "textbox", "stamp", "line", "polyline", "arrow", "rectangle", "circle", "polygon"]);
  const boxes = new Set(["cloud", "textbox", "stamp", "rectangle", "circle"]);
  const labels = Object.freeze({ cloud: "Cloud", textbox: "Textbox", stamp: "Stamp", line: "Line", polyline: "Line/Polyline", arrow: "Arrow", rectangle: "Rectangle", circle: "Circle", polygon: "Polygon" });
  const icons = Object.freeze({ cloud: "M6 18a4 4 0 0 1-2-7 5 5 0 0 1 9-5 4 4 0 0 1 6 5 4 4 0 0 1-1 7Z", textbox: "M3 4h18v16H3ZM7 8h10m-5 0v8m-3 0h6", stamp: "M4 17h16v4H4Zm2 0v-4h12v4M9 13V6a3 3 0 0 1 6 0v7", polyline: "M3 18l6-12 6 12 6-12", arrow: "M3 21 21 3m-9 0h9v9", rectangle: "M3 5h18v14H3Z", circle: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", polygon: "M12 2 22 9 18 22 5 20 2 8Z" });
  const defaults = () => ({ stroke_color: "#FF0000", stroke_width: 2, opacity: 1, fill_enabled: false, fill_color: "#FFFFFF", font_color: "#000000", font_size: 12 });
  function box(points, transform, inverse) {
    const [a, b] = points.map(transform), x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]), h = Math.abs(a[1] - b[1]);
    return { quad_pdf: [[x, y], [x+w, y], [x+w, y+h], [x, y+h]].map(inverse) };
  }
  function coordinates(graphic) { return graphic.geometry.quad_pdf || graphic.geometry.points; }
  function icon(kind, doc = root.document) {
    const el = doc.createElementNS("http://www.w3.org/2000/svg", "svg"), path = doc.createElementNS(el.namespaceURI, "path");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", width: 24, height: 24 })) el.setAttribute(key, value);
    path.setAttribute("d", icons[kind]); el.append(path); return el;
  }
  function textLines(text, width, size, bold, context) {
    context.font = `${bold ? "bold " : ""}${size}px CeasefireDrawing`; context.fontKerning = "none";
    if (bold) return [text];
    const lines = [];
    for (const source of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
      let line = "";
      for (const character of source) {
        if (line && context.measureText(line + character).width > width) { lines.push(line); line = ""; }
        line += character;
      }
      lines.push(line);
    }
    return lines;
  }
  function paint(graphic, transform, scale, make, context) {
    const group = make("g", { "pointer-events": "none" }), style = graphic.appearance, points = coordinates(graphic).map(transform), closed = boxes.has(graphic.kind) || graphic.kind === "polygon";
    const ink = { stroke: style.stroke_color, "stroke-width": style.stroke_width * scale, fill: closed && style.fill_enabled ? style.fill_color : "none", opacity: style.opacity, "stroke-linejoin": "round", "stroke-linecap": "round" };
    if (graphic.geometry.quad_pdf) {
      const [a, b, , d] = points, width = Math.hypot(b[0]-a[0], b[1]-a[1]), height = Math.hypot(d[0]-a[0], d[1]-a[1]);
      const local = make("g", { transform: `matrix(${(b[0]-a[0])/width} ${(b[1]-a[1])/width} ${(d[0]-a[0])/height} ${(d[1]-a[1])/height} ${a[0]} ${a[1]})` }); group.append(local);
      if (graphic.kind === "circle") local.append(make("ellipse", { ...ink, cx: width/2, cy: height/2, rx: width/2, ry: height/2 }));
      else if (graphic.kind === "cloud") {
        const radius = Math.min(8 * scale, width/8, height/8), edges = [[radius, radius, width-radius, radius], [width-radius, radius, width-radius, height-radius], [width-radius, height-radius, radius, height-radius], [radius, height-radius, radius, radius]];
        let path = `M ${radius} ${radius}`;
        for (const [x,y,endX,endY] of edges) {
          const dx=endX-x, dy=endY-y, length=Math.hypot(dx,dy), count=Math.min(64,Math.max(1,Math.ceil(length/(2*radius)))), ux=dx/length, uy=dy/length;
          for(let i=0;i<count;i++) { const start=i/count, end=(i+1)/count, middle=(start+end)/2; path += ` Q ${x+dx*middle+uy*radius} ${y+dy*middle-ux*radius} ${x+dx*end} ${y+dy*end}`; }
        }
        local.append(make("path", { ...ink, d: path+" Z" }));
      } else local.append(make("rect", { ...ink, width, height, rx: graphic.kind === "stamp" ? 3*scale : 0 }));
      if (["textbox", "stamp"].includes(graphic.kind)) {
        const padding = Math.min(6*scale, width/8, height/8), size = style.font_size*scale, lines = textLines(graphic.text, width-2*padding, size, graphic.kind === "stamp", context);
        lines.forEach((line,index) => { const text=make("text", { x: graphic.kind === "stamp" ? width/2 : padding, y: padding+size+index*size*1.25, fill: style.font_color, opacity: style.opacity, "font-family": "CeasefireDrawing", "font-kerning": "none", "font-variant-ligatures": "none", "font-size": size, "font-weight": graphic.kind === "stamp" ? "bold" : "normal", "text-anchor": graphic.kind === "stamp" ? "middle" : "start" }); text.textContent=line; local.append(text); });
      }
    } else {
      group.append(make(graphic.kind === "polygon" ? "polygon" : "polyline", { ...ink, points: points.map(p=>p.join(",")).join(" ") }));
      if (graphic.kind === "arrow") { const [a,b]=points, dx=b[0]-a[0], dy=b[1]-a[1], length=Math.hypot(dx,dy), head=Math.min(length/3, Math.max(8, style.stroke_width*4)*scale), ux=dx/length, uy=dy/length; group.append(make("polyline", { ...ink, fill:"none", points: [[b[0]-head*ux-head*.5*uy,b[1]-head*uy+head*.5*ux],b,[b[0]-head*ux+head*.5*uy,b[1]-head*uy-head*.5*ux]].map(p=>p.join(",")).join(" ") })); }
    }
    return group;
  }
  const api = Object.freeze({ kinds, boxes, labels, defaults, box, coordinates, icon, paint, textLines });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefireTakeoffGraphics = api;
})(typeof window === "object" ? window : null);
