"use strict";

// PDF-only marks use literal text, bounded geometry and validated embedded PNGs.
// Supplied SVG, HTML and external image URLs never enter this renderer.
(function (root) {
  // Area exclusion is a drawing gesture that edits its selected Area, never a
  // separately persisted mark or register record.
  const kinds = Object.freeze(["cloud", "textbox", "stamp", "line", "polyline", "arrow", "rectangle", "circle", "polygon", "measure", "area", "count"]);
  const tools = Object.freeze([...kinds.filter(kind => kind !== "count"), "area-exclusion"]);
  const boxes = new Set(["cloud", "textbox", "stamp", "rectangle", "circle"]);
  const labels = Object.freeze({ cloud: "Cloud", textbox: "Textbox", stamp: "Stamp", line: "Line", polyline: "Line/Polyline", arrow: "Arrow", rectangle: "Rectangle", circle: "Circle", polygon: "Polygon", measure: "Measure", area: "Area", count: "Count", "area-exclusion": "Area exclusion" });
  const icons = Object.freeze({ cloud: "M6 18a4 4 0 0 1-2-7 5 5 0 0 1 9-5 4 4 0 0 1 6 5 4 4 0 0 1-1 7Z", textbox: "M3 4h18v16H3ZM7 8h10m-5 0v8m-3 0h6", stamp: "M4 17h16v4H4Zm2 0v-4h12v4M9 13V6a3 3 0 0 1 6 0v7", polyline: "M3 18l6-12 6 12 6-12", arrow: "M3 21 21 3m-9 0h9v9", rectangle: "M3 5h18v14H3Z", circle: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", polygon: "M12 2 22 9 18 22 5 20 2 8Z", measure: "M3 8h18v8H3ZM7 8v4M11 8v3M15 8v4M19 8v3" });
  const defaults = () => ({ stroke_enabled: true, stroke_color: "#FF0000", stroke_width: 2, opacity: 1, fill_enabled: false, fill_color: "#FFFFFF", font_color: "#000000", font_size: 12 });
  const fontSize = graphic => graphic.appearance.font_size * (graphic.geometry.text_scale ?? 1);
  function resizedTextBox(graphic, geometry, userUnit = 1) {
    if (!["textbox", "stamp"].includes(graphic.kind) || graphic.stamp_image) return geometry;
    const inner = quad => {
      const width = Math.hypot(...quad[1].map((n,i)=>n-quad[0][i]))*userUnit, height = Math.hypot(...quad[3].map((n,i)=>n-quad[0][i]))*userUnit;
      const padding = Math.min(6,width/8,height/8);
      return [width-2*padding,height-2*padding];
    };
    const before=inner(graphic.geometry.quad_pdf), after=inner(geometry.quad_pdf);
    return {...geometry,text_scale:(graphic.geometry.text_scale ?? 1)*Math.min(after[0]/before[0],after[1]/before[1])};
  }
  function box(points, transform, inverse) {
    const [a, b] = points.map(transform), x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]), h = Math.abs(a[1] - b[1]);
    return { quad_pdf: [[x, y], [x+w, y], [x+w, y+h], [x, y+h]].map(inverse) };
  }
  function coordinates(graphic) { return graphic.geometry.quad_pdf || graphic.geometry.points; }
  // Only a retained box has dimensions to resize. Polygon/Area vertices and
  // line endpoints edit individual points, even when their outline looks boxy.
  const handleCursorRole = graphic => graphic.geometry.quad_pdf ? "resize-nwse" : "move";
  const imageByteLimit = 2 * 1024 * 1024;
  function imageSize(width, height) {
    if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 4096) || width * height > 4000000) throw new Error("Choose an image up to 4,096 pixels per side and 4 million pixels in total.");
    return { width, height };
  }
  function stampImageHeader(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > imageByteLimit) throw new Error("Choose a PNG or JPEG image up to 2 MiB.");
    if ([137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) {
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 33 || data.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12,16)) !== "IHDR") throw new Error("Choose a valid PNG image.");
      const size = imageSize(data.getUint32(16), data.getUint32(20));
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = data.getUint32(offset), end = offset + length + 12;
        if (end > bytes.length) throw new Error("Choose a complete PNG image.");
        if (String.fromCharCode(...bytes.slice(offset+4,offset+8)) === "acTL") throw new Error("Choose a single-frame PNG image.");
        offset = end;
      }
      return { mime_type: "image/png", ...size };
    }
    if (bytes[0] === 255 && bytes[1] === 216) {
      for (let offset = 2; offset < bytes.length;) {
        if (bytes[offset++] !== 255) throw new Error("Choose a valid JPEG image.");
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || marker >= 208 && marker <= 215) continue;
        if (offset + 2 > bytes.length) break;
        const length = bytes[offset] * 256 + bytes[offset+1];
        if (length < 2 || offset + length > bytes.length) break;
        if (marker >= 192 && marker <= 207 && ![196,200,204].includes(marker)) {
          if (length < 8) break;
          return { mime_type:"image/jpeg", ...imageSize(bytes[offset+5]*256+bytes[offset+6], bytes[offset+3]*256+bytes[offset+4]) };
        }
        offset += length;
      }
    }
    throw new Error("Choose a valid PNG or JPEG image; SVG and other formats are not supported.");
  }
  async function stampImage(file, decode = value => root.createImageBitmap(value)) {
    if (!file || !Number.isInteger(file.size) || file.size < 1 || file.size > imageByteLimit) throw new Error("Choose a PNG or JPEG image up to 2 MiB.");
    const bytes = new Uint8Array(await file.arrayBuffer()), header = stampImageHeader(bytes);
    if (file.type && file.type !== header.mime_type) throw new Error("The image file type does not match its bytes.");
    const bitmap = await decode(file);
    try { imageSize(bitmap.width, bitmap.height); } finally { bitmap.close?.(); }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset+8192));
    return { mime_type:header.mime_type, content_base64:btoa(binary) };
  }
  function stampDataUrl(image) {
    if (!image || image.version !== 1 || image.mime_type !== "image/png" || !/^[0-9a-f]{64}$/.test(image.sha256) || typeof image.content_base64 !== "string" || image.content_base64.length > Math.ceil(imageByteLimit/3)*4 || image.content_base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.content_base64)) throw new Error("The stored stamp image is invalid.");
    imageSize(image.width,image.height);
    const bytes = image.content_base64.length / 4 * 3 - (image.content_base64.endsWith("==") ? 2 : image.content_base64.endsWith("=") ? 1 : 0);
    if (bytes < 1 || bytes > imageByteLimit) throw new Error("The stored stamp image exceeds 2 MiB.");
    return `data:image/png;base64,${image.content_base64}`;
  }
  function stampAt(geometry, center, view) {
    const quad = geometry?.quad_pdf;
    if (!Array.isArray(quad) || quad.length !== 4 || quad.some(p=>!Array.isArray(p)||p.length!==2) || !Array.isArray(center) || center.length !== 2 || !Array.isArray(view) || view.length !== 4 || [...quad.flat(),...center,...view].some(n => typeof n !== "number" || !Number.isFinite(n))) throw new Error("Choose a valid stamp position on the current PDF page.");
    const prior = [0,1].map(axis => quad.reduce((sum,p) => sum+p[axis],0)/4), placed = quad.map(p => p.map((n,axis) => n+center[axis]-prior[axis]));
    if (placed.some(p => p.some((n,axis) => n < view[axis] || n > view[axis+2]))) throw new Error("Place the whole stamp inside the PDF page.");
    return { ...geometry, quad_pdf:placed };
  }
  function icon(kind, doc = root.document) {
    const el = doc.createElementNS("http://www.w3.org/2000/svg", "svg"), path = doc.createElementNS(el.namespaceURI, "path");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", width: 24, height: 24 })) el.setAttribute(key, value);
    path.setAttribute("d", kind === "area" ? "M3 3h18v18H3ZM7 7h10v10H7" : kind === "area-exclusion" ? "M3 3h18v18H3ZM8 12h8" : icons[kind]); el.append(path); return el;
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
  function richTextLines(content, width, size, context) {
    const lines = []; let number = 0;
    context.fontKerning = "none";
    for (const block of content.blocks) {
      number = block.kind === "number" ? number + 1 : 0;
      const prefix = block.kind === "bullet" ? "• " : number ? `${number}. ` : "";
      let line = [], used = 0;
      for (const run of [...(prefix ? [{text:prefix}] : []), ...block.runs]) {
        context.font = `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${size}px CeasefireDrawing`;
        for (const character of run.text.replace(/\r\n?/g,"\n").replace(/\t/g,"    ")) {
          const advance = context.measureText(character).width;
          if (character === "\n" || used && used + advance > width) { lines.push(line); line=[]; used=0; if(character === "\n") continue; }
          line.push({...run,text:character,x:used}); used += advance;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  function paint(graphic, transform, scale, make, context, measureResult = null, formatLength = value => value.toFixed(2)) {
    const group = make("g", { "pointer-events": "none" }), style = graphic.appearance, points = coordinates(graphic).map(transform), area = ["area", "area-exclusion"].includes(graphic.kind), closed = boxes.has(graphic.kind) || graphic.kind === "polygon" || area;
    const ink = { stroke: style.stroke_enabled === false ? "none" : style.stroke_color, "stroke-width": style.stroke_width * scale, fill: closed && style.fill_enabled ? style.fill_color : "none", opacity: style.opacity, "stroke-linejoin": "round", "stroke-linecap": "round" };
    if (graphic.kind === "count") {
      points.forEach(([x,y], index) => {
        group.append(make("circle", {...ink, cx:x, cy:y, r:5*scale, fill:style.fill_enabled ? style.fill_color : "none"}));
        const label = make("text", {x:x+7*scale,y:y-7*scale,fill:style.font_color,opacity:style.opacity,class:"takeoff-value-label","pointer-events":"none"});
        label.textContent = `${index+1} · ${formatLength(graphic.geometry.lengths_m[index])} m`; group.append(label);
      });
      return group;
    }
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
      if (graphic.kind === "stamp" && graphic.stamp_image) {
        const padding = Math.min(6*scale,width/8,height/8);
        local.append(make("image",{x:padding,y:padding,width:width-2*padding,height:height-2*padding,href:stampDataUrl(graphic.stamp_image),preserveAspectRatio:"xMidYMid meet",opacity:style.opacity}));
      } else if (["textbox", "stamp"].includes(graphic.kind)) {
        const padding = Math.min(6*scale, width/8, height/8), size = fontSize(graphic)*scale, rich = graphic.kind === "textbox" && graphic.text_content, lines = rich ? richTextLines(rich,width-2*padding,size,context) : textLines(graphic.text, width-2*padding, size, graphic.kind === "stamp", context);
        lines.forEach((line,index) => { const text=make("text", { x: graphic.kind === "stamp" ? width/2 : padding, y: padding+size+index*size*1.25, fill: style.font_color, opacity: style.opacity, "font-family": "CeasefireDrawing", "font-kerning": "none", "font-variant-ligatures": "none", "font-size": size, "font-weight": graphic.kind === "stamp" ? "bold" : "normal", "text-anchor": graphic.kind === "stamp" ? "middle" : "start" });
          if(rich) for(const run of line) { const span=make("tspan",{x:padding+run.x,"font-weight":run.bold?"bold":"normal","font-style":run.italic?"italic":"normal","text-decoration":run.underline?"underline":"none"});span.textContent=run.text;text.append(span); }
          else text.textContent=line; local.append(text); });
      }
    } else {
      if (area) {
        const rings=[points,...(graphic.geometry.exclusions || []).map(hole=>hole.points.map(transform))];
        group.append(make("path",{...ink,"fill-rule":"evenodd",d:rings.map(ring=>`M ${ring.map(p=>p.join(" ")).join(" L ")} Z`).join(" ")}));
      } else group.append(make(graphic.kind === "polygon" ? "polygon" : "polyline", { ...ink, points: points.map(p=>p.join(",")).join(" ") }));
      const amount=area ? measureResult?.net_area_m2 : measureResult?.length_m;
      if (["measure","area"].includes(graphic.kind) && measureResult?.status === "current" && measureResult.version === graphic.version && Number.isFinite(amount) && (!area || measureResult.label_point_pdf)) {
        const anchor = area ? transform(measureResult.label_point_pdf) : points[Math.floor((points.length - 1) / 2)], text = make("text", { x: anchor[0] + (area ? 0 : 6), y: anchor[1] + (area ? 0 : -8), ...(area ? {"text-anchor":"middle"} : {}), fill: style.font_color, opacity: style.opacity, class: "takeoff-value-label", "pointer-events": "none" });
        text.textContent = `${formatLength(amount)} ${area ? "m²" : "m"}`; group.append(text);
      }
      if (graphic.kind === "arrow") { const [a,b]=points, dx=b[0]-a[0], dy=b[1]-a[1], length=Math.hypot(dx,dy), head=Math.min(length/3, Math.max(8, style.stroke_width*4)*scale), ux=dx/length, uy=dy/length; group.append(make("polyline", { ...ink, fill:"none", points: [[b[0]-head*ux-head*.5*uy,b[1]-head*uy+head*.5*ux],b,[b[0]-head*ux+head*.5*uy,b[1]-head*uy-head*.5*ux]].map(p=>p.join(",")).join(" ") })); }
    }
    return group;
  }
  const api = Object.freeze({ kinds, tools, boxes, labels, defaults, box, coordinates, handleCursorRole, icon, paint, textLines, richTextLines, fontSize, resizedTextBox, imageByteLimit, stampImageHeader, stampImage, stampDataUrl, stampAt });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CeasefireTakeoffGraphics = api;
})(typeof window === "object" ? window : null);
