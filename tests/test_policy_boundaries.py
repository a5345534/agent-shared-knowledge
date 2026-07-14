from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import knowledge_lint as lint

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "knowledge_lint.py"


def test_agent_workspace_guidance_is_opt_in(workspace):
    path = workspace / "agent-workspace" / "guide.md"
    path.parent.mkdir(); path.write_text("[broken](missing.md)\n")
    assert path not in lint.workspace_guidance_files(workspace)
    assert path in lint.workspace_guidance_files(workspace, True)


def test_module_topology_lint_is_default_off_and_explicit_opt_in(workspace):
    (workspace / "knowledge/module-map").mkdir()
    backend = workspace / "projects/backend/module/payroll-module"
    backend.mkdir(parents=True); (backend / "RESPONSIBILITY.md").write_text("payroll\n")
    env = {**os.environ, "SHARED_KNOWLEDGE_ADOPTER_TOPOLOGY_LINT": "0"}
    default = subprocess.run([sys.executable, str(SCRIPT), "--root", str(workspace), "--format", "json"], env=env, text=True, capture_output=True)
    assert default.returncode == 0
    assert "module-map-orphan" not in default.stdout
    env["SHARED_KNOWLEDGE_ADOPTER_TOPOLOGY_LINT"] = "1"
    enabled = subprocess.run([sys.executable, str(SCRIPT), "--root", str(workspace), "--format", "json"], env=env, text=True, capture_output=True)
    assert "module-map-orphan" in enabled.stdout
