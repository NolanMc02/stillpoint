import struct, subprocess, os
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
os.chdir(os.path.dirname(os.path.abspath(__file__))+'/samples')
para = ("The river moved slowly past the old mill, carrying leaves and the pale reflection of the morning sky. "
 "Dr. Hale watched it from the bridge—she had always preferred water to people... Nobody asked her why. "
 "\"Extraordinarily complicated,\" she said, and the well-known-but-seldom-discussed arrangement continued for 25 years. ")
md = "---\ntitle: The Quiet River\nauthor: Test Author\n---\n\n"
for c in range(1,6):
    md += f"# Chapter {c}: Part of the River\n\n" + "\n\n".join([para*3]*8) + "\n\n"
open('book.md','w').write(md)
for ext in ['epub','docx','rtf','html']:
    subprocess.run(['pandoc','book.md','-s','-o',f'book.{ext}'],check=True)
open('book.txt','w').write(md.split('---\n\n',1)[1].replace('# ',''))
open('latin1.txt','wb').write("Caf\xe9 na\xefve r\xe9sum\xe9 text in an older encoding.\n\nSecond paragraph here.".encode('latin-1'))
open('bad.doc','wb').write(b'\xd0\xcf\x11\xe0'+b'\0'*500)

# PDF with running header, page numbers, split words, footnotes, outline
c = canvas.Canvas('book.pdf',pagesize=letter)
words=(para*30).split()
wi=0
for pg in range(1,13):
    c.setFont('Times-Roman',10); c.drawString(72,750,'The Quiet River: A Running Header')
    y=710
    if pg in (1,5,9):
        title=f'Chapter {(pg+3)//4}'
        c.setFont('Times-Bold',20); c.drawString(72,y,title); c.bookmarkPage(f'c{pg}'); c.addOutlineEntry(title,f'c{pg}',0); y-=36
    c.setFont('Times-Roman',12)
    lines=0
    while y>130:
        line=''
        while wi<len(words) and len(line)+len(words[wi])<72:
            line+=words[wi]+' '; wi+=1
        if wi>=len(words): wi=0
        if lines==3:
            line=line.rstrip()+' contin-'
        if lines==4:
            line='uation '+line
        c.drawString(72,y,line.strip()); y-=15; lines+=1
        if lines%10==0: y-=12
    c.setFont('Times-Roman',8.5); c.drawString(72,100,'1 A footnote about the mill and its long history.')
    c.setFont('Times-Roman',10); c.drawCentredString(306,50,str(pg))
    c.showPage()
c.save()
c=canvas.Canvas('scanned.pdf'); c.rect(50,50,300,300); c.showPage(); c.save()

# Minimal MOBI with PalmDoc compression (literals plus a back-reference)
html=("<html><body><h1>Chapter One</h1><p>"+para+"</p><h1>Chapter Two</h1><p>"+para+"</p></body></html>").encode()
def lit(data):
    out=bytearray()
    for i in range(0,len(data),8):
        ch=data[i:i+8]; out.append(len(ch)); out+=ch
    return bytes(out)
rec=[]
for i in range(0,len(html),4096): rec.append(lit(html[i:i+4096]))
title=b'Mobi River'
mobi=bytearray(b'MOBI'+struct.pack('>I',232))+b'\0'*224
struct.pack_into('>I',mobi,12,65001)
struct.pack_into('>I',mobi,68,16+232); struct.pack_into('>I',mobi,72,len(title))
palm=struct.pack('>HHIHHHH',2,0,len(html),len(rec),4096,0,0)
r0=palm+bytes(mobi)+title
records=[r0]+rec
hdr=bytearray(78+8*len(records)+2)
hdr[0:10]=b'mobi-river'; hdr[60:68]=b'BOOKMOBI'; struct.pack_into('>H',hdr,76,len(records))
o=len(hdr)
for i,r in enumerate(records):
    struct.pack_into('>I',hdr,78+8*i,o); o+=len(r)
open('book.mobi','wb').write(bytes(hdr)+b''.join(records))
# Protected EPUB
import zipfile
with zipfile.ZipFile('book.epub') as z, zipfile.ZipFile('drm.epub','w') as o:
    for n in z.namelist(): o.writestr(n,z.read(n))
    o.writestr('META-INF/encryption.xml','<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>')
