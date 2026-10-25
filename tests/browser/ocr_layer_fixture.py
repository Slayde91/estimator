"""Public synthetic native, scanned, tilted and French OCR drawing fixture."""
import argparse
from io import BytesIO
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))

def make_pdf(path):
    from PIL import Image,ImageDraw,ImageFont
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    from pypdf import PdfReader,PdfWriter
    from pypdf.generic import RectangleObject,NameObject,NumberObject
    font=ImageFont.truetype(str(ROOT/'static/fonts/Vera.ttf'),54)
    def image(text,skew=0):
        value=Image.new('RGB',(1400,220),'white');ImageDraw.Draw(value).text((45,65),text,font=font,fill='black')
        if skew:value=value.rotate(skew,resample=Image.Resampling.BICUBIC,expand=True,fillcolor='white')
        return ImageReader(value)
    body=BytesIO();pdf=canvas.Canvas(body,pagesize=(600,600),invariant=1)
    pdf.setFont('Helvetica',16);pdf.drawString(40,540,'Native PUMP ROOM label');pdf.drawImage(image('AIR CONDITIONER'),60,300,width=480,height=76);pdf.showPage()
    pdf.drawImage(image('AIR CONDITIONER'),80,420,width=350,height=55);pdf.showPage()
    pdf.drawImage(image('FIRE DAMPER',3),60,300,width=480,height=88);pdf.showPage()
    pdf.drawImage(image('SORTIE DE SÉCURITÉ'),60,300,width=480,height=76);pdf.showPage()
    for number in range(5,15):
        pdf.setFont('Helvetica',16);pdf.drawString(40,540,f'Native continuation page {number}');pdf.showPage()
    pdf.save()
    writer=PdfWriter();[writer.add_page(page) for page in PdfReader(body).pages]
    writer.pages[1].cropbox=RectangleObject([20,30,580,570]);writer.pages[1].rotate(90);writer.pages[1][NameObject('/UserUnit')]=NumberObject(2)
    with path.open('wb') as stream:writer.write(stream)

if __name__=='__main__':
    from estimator.server import create_server
    parser=argparse.ArgumentParser();parser.add_argument('--directory',required=True);folder=Path(parser.parse_args().directory).resolve();folder.mkdir(parents=True,exist_ok=True)
    fixture=folder/'ocr-layer-drawings.pdf';make_pdf(fixture);server=create_server(0,folder/'qa.sqlite3')
    print(json.dumps({'port':server.server_port,'fixture':str(fixture)}),flush=True)
    try:server.serve_forever()
    finally:server.server_close()
