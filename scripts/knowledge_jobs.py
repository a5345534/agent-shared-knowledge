#!/usr/bin/env python3
"""Safe status and retention operations for private knowledge jobs."""
from __future__ import annotations
import argparse, datetime as dt, json, os, sys
from pathlib import Path
from knowledge_sources import runtime_root

TERMINAL = {"done", "review-ready", "skipped", "failed"}

def jobs(root: Path) -> list[tuple[Path, dict]]:
    result=[]
    for path in sorted((runtime_root(root)/"jobs").glob("*.json")):
        try:
            value=json.loads(path.read_text(encoding="utf-8"))
            if value.get("version")==1: result.append((path,value))
        except (OSError,json.JSONDecodeError): pass
    return result

def safe(job: dict) -> dict:
    value = {key:job.get(key) for key in ("id","state","createdAt","updatedAt","attempts","nextAttemptAt","modelHint","sessionId","sourceInstance","purgedAt","error") if job.get(key) is not None}
    result = job.get("result")
    if isinstance(result, dict):
        value["result"] = {key: result.get(key) for key in ("candidateCount", "materializer", "written") if result.get(key) is not None}
    return value | {"hasPayload": bool(job.get("payload"))}

def main()->int:
    p=argparse.ArgumentParser();p.add_argument("--root",default="."); sub=p.add_subparsers(dest="command",required=True)
    sub.add_parser("status"); show=sub.add_parser("show");show.add_argument("job_id"); purge=sub.add_parser("purge");purge.add_argument("--retention-days",type=int,default=7);purge.add_argument("--dry-run",action="store_true");purge.add_argument("--all-terminal",action="store_true")
    a=p.parse_args();root=Path(a.root).resolve()
    if a.command=="status": value={"runtimeRoot":str(runtime_root(root)),"jobs":[safe(job) for _,job in jobs(root)]}
    elif a.command=="show":
        matches=[job for _,job in jobs(root) if job.get("id")==a.job_id]
        if not matches: print(json.dumps({"error":"job not found"}),file=sys.stderr);return 1
        job=matches[0]; result=job.get("result") if isinstance(job.get("result"),dict) else {}
        value={"job":safe(job),"reviewCandidates":result.get("reviewCandidates",[])}
    else:
        cutoff=dt.datetime.now(dt.timezone.utc).timestamp()-a.retention_days*86400; removed=[]
        for path,job in jobs(root):
            timestamp=job.get("updatedAt") or job.get("createdAt") or ""
            try: old=dt.datetime.fromisoformat(timestamp.replace("Z","+00:00")).timestamp()<=cutoff
            except ValueError: old=False
            result = job.get("result") if isinstance(job.get("result"), dict) else {}
            has_private_detail = bool(job.get("payload")) or bool(result.get("reviewCandidates"))
            if job.get("state") in TERMINAL and has_private_detail and (a.all_terminal or old):
                removed.append(job.get("id",path.stem))
                if not a.dry_run:
                    job["payload"] = None; result.pop("reviewCandidates", None); job["result"] = result or None
                    job["purgedAt"] = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
                    job["updatedAt"] = job["purgedAt"]
                    from knowledge_sources import atomic_json
                    atomic_json(path, job)
        value={"removed":removed,"dryRun":a.dry_run,"retentionDays":a.retention_days}
    print(json.dumps(value,ensure_ascii=False,indent=2));return 0
if __name__=="__main__":raise SystemExit(main())
