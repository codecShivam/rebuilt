# claude: first occurrence 2026-09-18 (testlibrary.com clone): turning a captured screen's markup into exact jsx by hand
# was the bulk of the rebuild work; a second clone done this way makes it a skill (or a builder-brief step).
"""convert a captured screen's markup (the #__nuxt subtree) into exact jsx.
usage: html2jsx.py <in.html> <out.jsx.txt> [image-map.json]"""
import sys, json, re
from html.parser import HTMLParser

SVG_ATTRS = {'viewbox':'viewBox','preserveaspectratio':'preserveAspectRatio','gradientunits':'gradientUnits','gradienttransform':'gradientTransform','patternunits':'patternUnits','patterntransform':'patternTransform','spreadmethod':'spreadMethod','markerwidth':'markerWidth','markerheight':'markerHeight','refx':'refX','refy':'refY','stddeviation':'stdDeviation','filterunits':'filterUnits','primitiveunits':'primitiveUnits','maskunits':'maskUnits','maskcontentunits':'maskContentUnits','clippathunits':'clipPathUnits','xlink:href':'xlinkHref','xmlns:xlink':'xmlnsXlink','xml:space':'xmlSpace','tabindex':'tabIndex','for':'htmlFor','class':'className','srcset':'srcSet','fetchpriority':'fetchPriority','crossorigin':'crossOrigin','autocomplete':'autoComplete','readonly':'readOnly','maxlength':'maxLength','minlength':'minLength','autofocus':'autoFocus','enterkeyhint':'enterKeyHint','inputmode':'inputMode','contenteditable':'contentEditable','spellcheck':'spellCheck','autoplay':'autoPlay','playsinline':'playsInline','colspan':'colSpan','rowspan':'rowSpan','datetime':'dateTime','frameborder':'frameBorder','allowfullscreen':'allowFullScreen','novalidate':'noValidate','formnovalidate':'formNoValidate','accesskey':'accessKey','http-equiv':'httpEquiv','usemap':'useMap','ismap':'isMap','referrerpolicy':'referrerPolicy'}
SVG_TAGS = {'clippath':'clipPath','lineargradient':'linearGradient','radialgradient':'radialGradient','fegaussianblur':'feGaussianBlur','feflood':'feFlood','feblend':'feBlend','fecolormatrix':'feColorMatrix','feoffset':'feOffset','fecomposite':'feComposite','femerge':'feMerge','femergenode':'feMergeNode','foreignobject':'foreignObject','textpath':'textPath','fedropshadow':'feDropShadow','femorphology':'feMorphology','feturbulence':'feTurbulence','fedisplacementmap':'feDisplacementMap','feimage':'feImage','fetile':'feTile','fecomponenttransfer':'feComponentTransfer','fefunca':'feFuncA','fefuncr':'feFuncR','fefuncg':'feFuncG','fefuncb':'feFuncB','fespecularlighting':'feSpecularLighting','fediffuselighting':'feDiffuseLighting','fepointlight':'fePointLight','fespotlight':'feSpotLight','fedistantlight':'feDistantLight'}
VOID = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
DROP_TAGS = {'script','noscript','iframe','style','link','meta','title','template'}

def kebab_to_camel(name):
    if name in SVG_ATTRS: return SVG_ATTRS[name]
    if name.startswith(('data-','aria-')): return name
    if '-' in name:
        head, *rest = name.split('-'); return head + ''.join(r[:1].upper()+r[1:] for r in rest)
    return name

def style_to_obj(value):
    parts=[]
    for decl in value.split(';'):
        if ':' not in decl: continue
        k,v=decl.split(':',1); k=k.strip(); v=v.strip()
        key = k if k.startswith('--') else kebab_to_camel(k)
        key = json.dumps(key) if key.startswith('--') else key
        parts.append(f'{key}: {json.dumps(v, ensure_ascii=False)}')
    return '{{ ' + ', '.join(parts) + ' }}'

class Node:
    def __init__(self, tag, attrs): self.tag=tag; self.attrs=attrs; self.children=[]
class Text:
    def __init__(self, s): self.s=s

class P(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True); self.root=Node('#root',[]); self.stack=[self.root]; self.skip=0
    def handle_starttag(self, tag, attrs):
        if tag in DROP_TAGS or self.skip: 
            if tag not in VOID: self.skip+=1
            return
        n=Node(tag, attrs); self.stack[-1].children.append(n)
        if tag not in VOID: self.stack.append(n)
    def handle_startendtag(self, tag, attrs):
        if self.skip or tag in DROP_TAGS: return
        self.stack[-1].children.append(Node(tag, attrs))
    def handle_endtag(self, tag):
        if self.skip:
            if tag not in VOID: self.skip-=1
            return
        if tag in VOID: return
        # pop to the matching open tag
        for i in range(len(self.stack)-1, 0, -1):
            if self.stack[i].tag==tag: del self.stack[i:]; return
    def handle_data(self, data):
        if self.skip: return
        self.stack[-1].children.append(Text(data))

def find(node, pred):
    if isinstance(node, Node):
        if pred(node): return node
        for c in node.children:
            r=find(c, pred)
            if r: return r
    return None

def emit(node, image_map, indent=0, out=None):
    pad='  '*indent
    if isinstance(node, Text):
        if node.s=='' : return
        out.append(pad + '{' + json.dumps(node.s, ensure_ascii=False) + '}')
        return
    tag = SVG_TAGS.get(node.tag, node.tag)
    attrs=[]
    for k,v in node.attrs:
        if k.startswith('data-v-') or k.startswith('on') or k=='data-nuxt-img': continue
        if v is None: v=''
        if k=='style':
            attrs.append(f'style={style_to_obj(v)}'); continue
        if k in ('src','srcset') and image_map:
            for u,l in image_map.items(): v=v.replace(u, l).replace(u.replace('&','&amp;'), l)
        name=kebab_to_camel(k)
        if '"' in v or '\n' in v: attrs.append(f'{name}={{{json.dumps(v, ensure_ascii=False)}}}')
        else: attrs.append(f'{name}="{v}"')
    a=(' '+' '.join(attrs)) if attrs else ''
    kids=[c for c in node.children if not (isinstance(c,Text) and c.s=='')]
    if not kids:
        out.append(f'{pad}<{tag}{a} />'); return
    # a single short text child stays inline
    if len(kids)==1 and isinstance(kids[0],Text) and len(kids[0].s)<70:
        out.append(f'{pad}<{tag}{a}>{{{json.dumps(kids[0].s, ensure_ascii=False)}}}</{tag}>'); return
    out.append(f'{pad}<{tag}{a}>')
    for c in kids: emit(c, image_map, indent+1, out)
    out.append(f'{pad}</{tag}>')

src, dst = sys.argv[1], sys.argv[2]
image_map = json.load(open(sys.argv[3])) if len(sys.argv)>3 else {}
p=P(); p.feed(open(src).read())
nuxt = find(p.root, lambda n: dict(n.attrs).get('id')=='__nuxt')
root = nuxt if nuxt else p.root
out=[]
for c in root.children: emit(c, image_map, 0, out)
open(dst,'w').write('\n'.join(out)+'\n')
print(dst, len(out), 'lines')
