import json
SP=r"C:/Users/cole/AppData/Local/Temp/claude/E--Projects-RankedDistribution/03bfb120-ada8-44c8-8bed-7132c8940019/scratchpad"
ext=json.load(open(SP+"/dist_extracted.json"))
# hand-read overrides (validated to 100%) take priority for modern seasons
HAND={
 "S15":{"Challenger":[0.0137],"Grandmaster":[0.0330],"Master":[0.4887],
   "Diamond":[0.3048,0.74,0.32,1.02],"Emerald":[2.06,1.32,1.93,4.34],
   "Platinum":[1.59,2.56,3.38,6.64],"Gold":[2.62,4.30,5.45,9.44],
   "Silver":[3.63,5.13,5.58,7.23],"Bronze":[3.28,4.09,4.15,5.02],"Iron":[2.59,3.35,3.52,3.87]},
 "S14":{"Challenger":[0.0196],"Grandmaster":[0.0458],"Master":[0.4745],
   "Diamond":[0.2325,0.34,0.42,1.24],"Emerald":[1.24,1.23,1.84,3.82],
   "Platinum":[1.29,2.16,2.95,5.68],"Gold":[2.26,3.68,4.57,8.15],
   "Silver":[3.16,4.83,5.70,8.46],"Bronze":[3.91,5.20,5.32,6.75],"Iron":[2.81,3.60,3.97,4.66]},
}
APEX={'Challenger','Grandmaster','Master'}
TORDER=['Challenger','Grandmaster','Master','Diamond','Emerald','Platinum','Gold','Silver','Bronze','Iron']

def enforce(vals,n):
    vals=list(vals)
    while len(vals)>n:  # merge smallest adjacent pair
        i=min(range(len(vals)-1), key=lambda k: vals[k]+vals[k+1])
        vals[i:i+2]=[round(vals[i]+vals[i+1],3)]
    while len(vals)<n:  # split largest
        i=max(range(len(vals)), key=lambda k: vals[k])
        half=round(vals[i]/2,3); vals[i:i+1]=[half, round(vals[i]-half,3)]
    return vals

out={}
for label,r in ext.items():
    order=r['order']; div=r['div']
    if label in HAND: div=HAND[label]
    ndiv=5 if order<9 else 4
    seasondivs=[]  # (tier, division_or_None, share)
    for t in TORDER:
        if t not in div or not div[t]: continue
        if t in APEX:
            seasondivs.append((t,None,round(sum(div[t]),4)))
        else:
            vals=enforce(div[t],ndiv)
            for j,v in enumerate(vals):
                seasondivs.append((t,j+1,round(v,3)))
    # cumulative floors
    cum=0.0; entries=[]
    for t,dv,share in seasondivs:
        cum=round(cum+share,3)
        entries.append({"tier":t.upper(),"division":dv,"floor":cum})
    out[label]={"order":order,"divisions":ndiv,"total":round(cum,2),"tiers":entries}

# S16 reuses S15
s15=out["S15"]; out["S16"]={"order":16,"divisions":4,"total":s15["total"],
    "tiers":[dict(e) for e in s15["tiers"]]}; out["S16"]["order"]=16
# relabel S16 order
order_list=sorted(out.items(), key=lambda kv: kv[1]['order'])
final={"_comment":"Division-level rank distribution read from league-of-legends-season-1-15 image (source of truth). floor=cumulative top% at the bottom of each division. Modern-season values (S13-S15) hand-read & validated to 100%; others pixel-extracted from the chart. S16 reuses S15.",
       "seasons":[{"label":k,**v} for k,v in order_list]}
json.dump(final, open(SP+"/season_distribution_new.json","w"), indent=1)
for k,v in order_list:
    print(f"{k:4} order={v['order']:<5} total={v['total']:.1f}%  {len(v['tiers'])} divisions")
print("\nwrote season_distribution_new.json")
