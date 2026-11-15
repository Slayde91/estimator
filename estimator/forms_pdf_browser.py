"""Use the installed browser's text shaper for scripts outside the embedded PDF fonts."""
import base64
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore
from xml.sax.saxutils import escape

from reportlab.platypus import Image, PageBreak, Paragraph, Spacer

from .catalog import ValidationError

_engines = BoundedSemaphore(2)


def _engine():
    for name in ('msedge','google-chrome','chromium','chromium-browser','chrome'):
        binary = shutil.which(name)
        if binary:
            return binary
    for folder in (os.environ.get('PROGRAMFILES'),os.environ.get('PROGRAMFILES(X86)'),os.environ.get('LOCALAPPDATA')):
        if folder:
            for suffix in ('Microsoft/Edge/Application/msedge.exe','Google/Chrome/Application/chrome.exe'):
                path = Path(folder)/suffix
                if path.is_file():
                    return str(path)
    for app, executable in [('Google Chrome','Google Chrome'),('Microsoft Edge','Microsoft Edge'),('Chromium','Chromium')]:
        path = Path('/Applications')/(app+'.app')/'Contents/MacOS'/executable
        if path.is_file():
            return str(path)
    raise ValidationError('This form uses characters that need Microsoft Edge or Chrome for the PDF download. Install either browser and try again.')


def _html(item):
    if isinstance(item,Paragraph):
        style = item.style
        align = {0:'left',1:'center',2:'right'}.get(style.alignment,'left')
        weight = 'bold' if 'Bold' in style.fontName else 'normal'
        colour = (style.textColor.hexval() if style.textColor else '#181818').replace('0x','#')
        markup = getattr(item, 'form_markup', None)
        if markup is None:
            markup = escape(getattr(item,'form_text',item.getPlainText()))
        return (f'<p dir="auto" style="font-size:{style.fontSize}pt;color:{colour};font-weight:{weight};'
                f'text-align:{align};margin:{style.spaceBefore}pt 0 {style.spaceAfter}pt">{markup}</p>')
    if isinstance(item,Image):
        data = base64.b64encode(item.form_image.getvalue()).decode()
        mime = 'image/png' if data.startswith('iVBOR') else 'image/jpeg'
        align = item.hAlign.lower()
        return f'<div style="text-align:{align}"><img width="{item.drawWidth*96/72:g}" src="data:{mime};base64,{data}"></div>'
    if isinstance(item,Spacer):
        return f'<div style="height:{item.height}pt"></div>'
    if isinstance(item,PageBreak):
        return '<div class="page-break"></div>'
    rows,widths,headers = item.form_rows
    cols = ''.join(f'<col style="width:{100*w/sum(widths):g}%">' for w in widths)
    def row_html(row,tag):
        cells = []
        for cell in row:
            parts = cell if isinstance(cell,list) else [cell] if cell else []
            cells.append(f'<{tag}>'+''.join(_html(part) for part in parts)+f'</{tag}>')
        return '<tr>'+''.join(cells)+'</tr>'
    head = '<thead>'+row_html(rows[0],'th')+'</thead>' if headers else ''
    body = ''.join(row_html(row,'td') for row in rows[int(headers):])
    return '<table><colgroup>'+cols+'</colgroup>'+head+'<tbody>'+body+'</tbody></table>'


def render_shaped_pdf(story, title, accent, orientation):
    # Only markup made here is loaded. Record text stays escaped, images are embedded
    # bytes, and CSP prevents network/file subresources, scripts and external navigation.
    css = ('@page{size:A4 '+orientation+';margin:15mm;@bottom-right{content:counter(page);font:8pt sans-serif}}'
           'body{margin:0;font:9pt/1.45 system-ui,sans-serif;color:#181818;print-color-adjust:exact}'
           'p{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;table-layout:fixed;border-collapse:collapse}'
           'th,td{padding:3pt 6pt;vertical-align:top;border-bottom:.5pt solid #ccc}th{background:'+accent+'}'
           'img{max-width:100%;height:auto}.page-break{break-after:page}')
    document = ('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" '
                'content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><title>'+escape(title)+
                '</title><style>'+css+'</style>'+''.join(_html(item) for item in story))
    browser = _engine()
    with _engines, TemporaryDirectory(prefix='classifire-form-',ignore_cleanup_errors=True) as folder:
        directory = Path(folder)
        source = directory/'form.html'
        pdf = directory/'form.pdf'
        source.write_text(document,encoding='utf-8')
        command = [browser,'--headless','--disable-gpu','--disable-extensions','--disable-sync','--no-first-run',
                   '--disable-background-networking','--disable-component-update','--no-pdf-header-footer',
                   '--user-data-dir='+str(directory/'profile'),'--print-to-pdf='+str(pdf),source.as_uri()]
        try:
            subprocess.run(command,check=True,timeout=45,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                           creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            return pdf.read_bytes()
        except (OSError,subprocess.SubprocessError) as exc:
            raise ValidationError('The browser could not render the international text in this form PDF. Try the download again.') from exc
