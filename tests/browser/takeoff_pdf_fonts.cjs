"use strict";
// Browser/PDF font metrics use disposable static pages; no app or saved draft.
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".runtime/browser-qa", `takeoff-pdf-fonts-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const reference = JSON.parse(execFileSync(process.env.CEASEFIRE_PYTHON || "python", ["-c", `
import json
from estimator.pdf_fonts import register_pdf_fonts, FONT_REGULAR, FONT_BOLD, FONT_ITALIC, FONT_BOLD_ITALIC
from estimator.takeoff_markup_pdf_worker import _annotation_lines
from reportlab.pdfbase.pdfmetrics import getFont, stringWidth
register_pdf_fonts()
text = 'Office WMW 1,001.125 mm fi fl \\u00e9 \\u2022'
content = {'version': 1, 'blocks': [
    {'kind': 'paragraph', 'runs': [{'text': text}, {'text': ' bold', 'bold': True}, {'text': ' italic', 'italic': True}, {'text': ' both', 'bold': True, 'italic': True}]},
    {'kind': 'bullet', 'runs': [{'text': 'Underlined callout', 'underline': True}]},
    {'kind': 'number', 'runs': [{'text': 'Final line'}]}]}
lines = _annotation_lines(content, 128, 13)
faces = []
for font in (FONT_REGULAR, FONT_BOLD, FONT_ITALIC, FONT_BOLD_ITALIC):
    units = getFont(font).face.unitsPerEm
    faces.append({'name': font, 'units': units, 'advances': [stringWidth(char, font, units) for char in text]})
print(json.dumps({'text': text, 'content': content, 'faces': faces, 'lines': [''.join(run[0] for run in line) for line in lines]}))
`], { cwd: root, encoding: "utf8", windowsHide: true }));
const resources = new Map();
for (const name of ["takeoffs.css", "takeoff-graphics.js", ...["Regular", "Bold", "Italic", "BoldItalic"].map(face => `fonts/Montserrat-${face}.ttf`)]) {
  resources.set("/" + name, fs.readFileSync(path.join(root, "static", name)));
}
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/takeoffs.css"></head><body><script src="/takeoff-graphics.js"></script></body></html>';
const server = http.createServer((request, response) => {
  const data = request.url === "/" ? Buffer.from(html) : resources.get(request.url);
  if (!data) { response.writeHead(request.url === "/favicon.ico" ? 204 : 404); response.end(); return; }
  const type = request.url.endsWith(".ttf") ? "font/ttf" : request.url.endsWith(".css") ? "text/css" : request.url.endsWith(".js") ? "text/javascript" : "text/html";
  response.writeHead(200, { "Content-Type": type }); response.end(data);
});
let browser;
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const actual = await page.evaluate(async reference => {
    const styles = ["", "bold ", "italic ", "italic bold "];
    const loaded = await Promise.all(styles.map(style => document.fonts.load(style + "13px CeasefireDrawing")));
    const context = document.createElement("canvas").getContext("2d");
    context.fontKerning = "none";
    // At display size Linux can fit glyph advances to whole pixels. Measure each
    // face at one pixel per font design unit to compare its actual advance table.
    const advances = styles.map((style, i) => {
      context.font = style + reference.faces[i].units + "px CeasefireDrawing";
      return [...reference.text].map(character => context.measureText(character).width);
    });
    const lines = window.CeasefireTakeoffGraphics.richTextLines(reference.content, 128, 13, context).map(line => line.map(run => run.text).join(""));
    return { advances, lines, loaded: loaded.map(faces => faces.map(face => ({ family: face.family, weight: face.weight, style: face.style, status: face.status }))) };
  }, reference);
  assert.deepEqual(actual.lines, reference.lines, "Mixed-style rich text wraps at the same characters as the PDF");
  actual.advances.forEach((advances, i) => {
    const face = reference.faces[i];
    assert.equal(advances.length, face.advances.length);
    advances.forEach((width, index) => assert.ok(Math.abs(width - face.advances[index]) < .01,
      `${face.name}, glyph ${index}: browser ${width}, PDF ${face.advances[index]} design units`));
  });
  assert.ok(actual.loaded.every(faces => faces.length === 1 && faces[0].status === "loaded"));
  assert.deepEqual(actual.loaded.map(faces => [faces[0].weight, faces[0].style]), [["400", "normal"], ["700", "normal"], ["400", "italic"], ["700", "italic"]]);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ completed: true, reference, actual, errors }, null, 2));
  console.log(`PASS: Four real font faces, exact character wrapping, browser/PDF metric agreement. Evidence: ${output}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
