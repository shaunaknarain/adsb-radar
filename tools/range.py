#!/usr/bin/env python3
# Range report from dump1090-fa history (~last 60 min).
# Usage: RX_LAT=.. RX_LON=.. range.py [label]   (appends to ~/range_log.jsonl)
import json, math, glob, os, sys, time
lat0,lon0=float(os.environ["RX_LAT"]),float(os.environ["RX_LON"])  # receiver position
def db(a,b):
    p1,p2=math.radians(lat0),math.radians(a); dl=math.radians(b-lon0)
    h=math.sin((p2-p1)/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    br=(math.degrees(math.atan2(math.sin(dl)*math.cos(p2),math.cos(p1)*math.sin(p2)-math.sin(p1)*math.cos(p2)*math.cos(dl)))+360)%360
    return 2*3440.065*math.asin(math.sqrt(h)),br
best={}; times=[]; msgs=[]
for f in glob.glob("/run/dump1090-fa/history_*.json"):
    d=json.load(open(f)); times.append(d["now"]); msgs.append((d["now"],d["messages"]))
    for x in d["aircraft"]:
        if "lat" in x and x.get("seen_pos",99)<=30:
            r,b=db(x["lat"],x["lon"])
            if r>best.get(x["hex"],(0,))[0]: best[x["hex"]]=(r,b)
sec=[0]*8
for r,b in best.values(): i=int(((b+22.5)%360)//45); sec[i]=max(sec[i],r)
rs=sorted(r for r,b in best.values()); msgs.sort()
rate=(msgs[-1][1]-msgs[0][1])/(msgs[-1][0]-msgs[0][0])
out={"label":sys.argv[1] if len(sys.argv)>1 else "","at":time.strftime("%Y-%m-%d %H:%M"),"window_min":round((max(times)-min(times))/60),
     "aircraft":len(rs),"max":round(rs[-1],1),"p90":round(rs[int(.9*len(rs))],1),"median":round(rs[len(rs)//2],1),"msg_per_s":round(rate),
     "sectors":dict(zip("N NE E SE S SW W NW".split(),[round(s,1) for s in sec]))}
print(json.dumps(out)); open(os.path.expanduser("~/range_log.jsonl"),"a").write(json.dumps(out)+"\n")
