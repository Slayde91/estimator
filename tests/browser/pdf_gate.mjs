import * as pdfjs from '/vendor/pdfjs/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
window.gateResult = {done:false, pages:[], violations:[]};
document.addEventListener('securitypolicyviolation', event => window.gateResult.violations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));
try {
  const pdf = await pdfjs.getDocument({url:'/fixture.pdf', cMapUrl:'/vendor/pdfjs/cmaps/', cMapPacked:true,
    standardFontDataUrl:'/vendor/pdfjs/standard_fonts/', wasmUrl:'/vendor/pdfjs/wasm/', iccUrl:'/vendor/pdfjs/iccs/',
    useWasm:false, disableFontFace:true, stopAtErrors:true, enableXfa:false, maxImageSize:100000000}).promise;
  for(let number=1; number<=pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({scale:.8});
    const canvas = document.createElement('canvas'); canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
    document.body.append(canvas); const context = canvas.getContext('2d');
    await page.render({canvasContext:context,viewport}).promise;
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    let marked=0; for(let i=0;i<pixels.length;i+=4) if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<220) marked++;
    const point=[page.view[0]+10,page.view[1]+10], screen=viewport.convertToViewportPoint(...point), restored=viewport.convertToPdfPoint(...screen);
    window.gateResult.pages.push({number,marked,view:page.view,rotation:page.rotate,userUnit:page.userUnit,
      coordinateError:Math.max(Math.abs(point[0]-restored[0]),Math.abs(point[1]-restored[1])),textItems:(await page.getTextContent()).items.length});
    page.cleanup();
  }
  window.gateResult.done=true;
} catch(error) { window.gateResult.error=String(error.stack||error);window.gateResult.done=true; }
