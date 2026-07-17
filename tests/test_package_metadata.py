"""Package manifest smoke tests for Pi lifecycle resources."""
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_pi_peer_dependencies_and_typecheck_are_declared() -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    assert package["peerDependencies"]["@earendil-works/pi-ai"] == "*"
    assert package["peerDependencies"]["@earendil-works/pi-coding-agent"] == "*"
    assert package["peerDependencies"]["@earendil-works/pi-tui"] == "*"
    assert package["scripts"]["typecheck"] == "tsc --noEmit"
    assert "tsconfig.json" in package["files"]
    assert "src" in package["files"]


def test_package_has_one_canonical_lifecycle_extension() -> None:
    extension_files = list((ROOT / ".pi" / "extensions").glob("**/*.ts"))

    assert extension_files == [ROOT / ".pi" / "extensions" / "shared-knowledge-lifecycle.ts"]
    assert (ROOT / "src" / "pi-lifecycle-materializer.ts").is_file()
