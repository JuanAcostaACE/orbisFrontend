"""Construye bench/dataset.json desde COCO val2017 (random.seed(42)) y descarga las 60 imagenes.
Uso: python -I build_dataset.py <instances_val2017.json> <dir_imagenes> <salida_dataset.json>"""
import json, random, sys, os, urllib.request
ann_path, img_dir, out = sys.argv[1:4]
random.seed(42)
d = json.load(open(ann_path, encoding='utf-8'))
imgs = {i['id']: i for i in d['images']}
cats = {c['id']: c['name'] for c in d['categories']}
per = {}      # id -> personas no crowd
crowd = {}    # id -> bool tiene persona crowd
objs = {}     # id -> set de categorias
for a in d['annotations']:
    objs.setdefault(a['image_id'], set()).add(cats[a['category_id']])
    if a['category_id'] == 1:
        if a['iscrowd']: crowd[a['image_id']] = True
        else: per.setdefault(a['image_id'], []).append(a['bbox'])
def area_frac(b, im): return b[2]*b[3]/(im['width']*im['height'])
def inter(a, b):
    w = min(a[0]+a[2], b[0]+b[2]) - max(a[0], b[0]); h = min(a[1]+a[3], b[1]+b[3]) - max(a[1], b[1])
    return max(0, w)*max(0, h)
def touches_edge(b, im, tol=1.0):
    return b[0] <= tol or b[1] <= tol or b[0]+b[2] >= im['width']-tol or b[1]+b[3] >= im['height']-tol
def overlapped(i, bs):
    for k, b in enumerate(bs):
        if b[2]*b[3] <= 0: continue
        for j, o in enumerate(bs):
            if j != i and inter(b, o)/(b[2]*b[3]) > 0.30: return True
    return False
ids = sorted(imgs)
person_ids = [i for i in ids if i in per and not crowd.get(i)]
noperson = [i for i in ids if 'person' not in objs.get(i, set())]
conf_set = {'potted plant', 'vase', 'teddy bear'}  # 'doll' no existe en COCO
used = set(); chosen = {}
def pick(name, cand, n):
    cand = [i for i in cand if i not in used]
    s = sorted(random.sample(cand, n)); used.update(s); chosen[name] = s
pick('grandes', [i for i in person_ids if any(area_frac(b, imgs[i]) > 0.15 for b in per[i])], 12)
pick('pequenas', [i for i in person_ids if all(area_frac(b, imgs[i]) < 0.01 for b in per[i])], 12)
pick('dificiles', [i for i in person_ids if any(b[3]/max(b[2], 1e-6) < 1.2 and area_frac(b, imgs[i]) >= 0.02 for b in per[i])], 8)
pick('ocluidas', [i for i in person_ids if any((touches_edge(b, imgs[i]) or overlapped(k, per[i])) and area_frac(b, imgs[i]) >= 0.02 for k, b in enumerate(per[i]))], 8)
pick('multiples', [i for i in person_ids if len(per[i]) >= 3], 10)
conf = [i for i in noperson if objs.get(i, set()) & conf_set]
used_before = set(used)
cs = sorted(random.sample(conf, 5)); used.update(cs)
rest = [i for i in noperson if i not in used and not (objs.get(i, set()) & conf_set)]
ps = sorted(random.sample(rest, 5)); used.update(ps)
groups = {i: 'confundibles' for i in cs}; groups.update({i: 'sin_persona_simple' for i in ps})
chosen['sin_persona'] = sorted(cs + ps)
os.makedirs(img_dir, exist_ok=True)
res = {'seed': 42, 'fuente': 'COCO val2017 (CC BY 4.0)', 'imagenes': []}
for st, lst in chosen.items():
    for i in lst:
        im = imgs[i]
        e = {'id': i, 'file_name': im['file_name'], 'width': im['width'], 'height': im['height'], 'estrato': st,
             'personas_bbox_xywh': per.get(i, []), 'tiene_persona_crowd_ignorada': bool(crowd.get(i))}
        if st == 'sin_persona':
            e['grupo'] = groups[i]; e['objetos_coco'] = sorted(objs.get(i, set()))
        res['imagenes'].append(e)
        p = os.path.join(img_dir, im['file_name'])
        if not os.path.exists(p): urllib.request.urlretrieve('http://images.cocodataset.org/val2017/' + im['file_name'], p)
json.dump(res, open(out, 'w'), separators=(',', ':'))
print({k: len(v) for k, v in chosen.items()}, len(res['imagenes']))
