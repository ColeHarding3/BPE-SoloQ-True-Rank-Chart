from PIL import Image
import numpy as np, json
im = Image.open(r"E:/Projects/RankedDistribution/league-of-legends-season-1-15-rank-distribution-comparison.png").convert("RGB")
a = np.asarray(im).astype(int); h,w,_=a.shape
CH = {1:(481,3509,100.0), 2:(4371,7399,10.5), 3:(8261,11289,1.05)}

def columns(y0,y100):
    sub=a[y0:y100]; nonwhite=~((sub>238).all(axis=2)); inbar=nonwhite.mean(axis=0)>0.30
    cols=[]; s=None
    for i,v in enumerate(inbar):
        if v and s is None: s=i
        if (not v) and s is not None: cols.append((s,i)); s=None
    if s is not None: cols.append((s,len(inbar)))
    return [(x0,x1) for x0,x1 in cols if x1-x0>60]

def segs_of(x0,x1,y0,y100,maxpct,thr=16):
    span=y100-y0
    prof=np.median(a[y0:y100, x0+12:x1-12, :],axis=1)
    runs=[]; start=0
    for y in range(1,len(prof)):
        if np.abs(prof[y]-prof[start]).sum()>thr: runs.append((start,y-1)); start=y
    runs.append((start,len(prof)-1))
    kept=[]
    for (r0,r1) in runs:
        if r1-r0<8: continue
        c=np.median(prof[r0:r1+1],axis=0)
        if c.min()>238 or c.max()<70: continue
        kept.append([r0,r1,tuple(int(v) for v in c)])
    out=[]
    for i,(r0,r1,c) in enumerate(kept):
        top=r0 if i==0 else (kept[i-1][1]+r0)//2
        bot=r1 if i==len(kept)-1 else (r1+kept[i+1][0])//2
        out.append([(bot-top)/span*maxpct, c])
    return out

def fam(c):
    r,g,b=c
    if b>r+15 and b>150 and g>140: return 'Diamond'
    if r>150 and b>110 and (r-g)>25 and g<140: return 'Master'
    if r>160 and g<110 and b<110: return 'Grandmaster'
    if g>=r-3 and g>b+5 and not(r>225 and g>205):
        return 'Emerald' if (r-b)>20 else 'Platinum'
    if r>210 and g>165 and b<148 and (r-b)>60: return 'yellow'
    if r>g>=b-6 and (r-b)>24: return 'Bronze'
    if abs(r-g)<22 and abs(g-b)<26: return 'gray'
    return '?'

def group(segs, chart):
    # returns ordered list of (tier, [div%...])
    labeled=[]
    for v,c in segs:
        f=fam(c)
        if chart==1:
            if f in ('Diamond','Master','Grandmaster'): continue  # from other charts
            if f=='yellow': f='Gold'
        labeled.append((f,v))
    groups=[]
    for f,v in labeled:
        if f=='?':
            if groups: groups[-1][1].append(v)   # attach stray to previous tier
            continue
        if groups and groups[-1][0]==f: groups[-1][1].append(v)
        else: groups.append([f,[v]])
    # resolve gray -> Silver / Iron by position around Bronze
    seen_bronze=False; res=[]
    for f,vs in groups:
        if f=='Bronze': seen_bronze=True; res.append(('Bronze',vs))
        elif f=='gray': res.append(('Iron' if seen_bronze else 'Silver', vs))
        else: res.append((f,vs))
    return res

IDX=[('S1',1),('S2',2),('S3',3),('S4',4),('S5',5),('S6',6),('S7',7),('S8',8),
     ('S9',9),('S10',10),('S11',11),('S12',12),('S13.1',13.1),('S13',13),
     ('S14.1',14.1),('S14.2',14.2),('S14',14),('S15',15)]
NEED={3,4,5,6,7,8,9,10,11,13,16,17}
c1=columns(*CH[1][:2]); c2=columns(*CH[2][:2]); c3=columns(*CH[3][:2])

result={}
for idx in sorted(NEED):
    label,order=IDX[idx]
    g1=group(segs_of(*c1[idx],*CH[1]),1)
    entry={}
    for t,vs in g1:
        entry[t]=entry.get(t,[])+[round(x,3) for x in vs]
    # Diamond from chart2 (cyan)
    dia=[round(v,3) for v,c in segs_of(*c2[idx],*CH[2]) if fam(c)=='Diamond']
    if dia: entry['Diamond']=dia
    # apex from chart3
    s3=segs_of(*c3[idx],*CH[3])
    for v,c in s3:
        f=fam(c)
        if f=='Challenger': entry.setdefault('Challenger',[round(v,4)])
        elif f=='Grandmaster': entry.setdefault('Grandmaster',[round(v,4)])
        elif f=='Master': entry.setdefault('Master',[round(v,4)])
        elif f=='yellow': entry.setdefault('Challenger',[round(v,4)])  # top yellow in 0-1% = challenger
    order_t=['Challenger','Grandmaster','Master','Diamond','Emerald','Platinum','Gold','Silver','Bronze','Iron']
    ent={t:entry[t] for t in order_t if t in entry}
    tot=sum(sum(v) for v in ent.values())
    result[label]={'order':order,'sum':round(tot,2),'div':{t:[round(x,2) for x in v] for t,v in ent.items()}}

for lbl,r in result.items():
    counts="/".join(f"{t[0]}{len(v)}" for t,v in r['div'].items())
    print(f"{lbl:5} sum={r['sum']:6.2f}%  [{counts}]")
json.dump(result, open(r"C:/Users/cole/AppData/Local/Temp/claude/E--Projects-RankedDistribution/03bfb120-ada8-44c8-8bed-7132c8940019/scratchpad/dist_extracted.json","w"), indent=1)
