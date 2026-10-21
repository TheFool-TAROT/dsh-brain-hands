#!/usr/bin/env python3
"""验收 hand 的产出：语法 / 导入 / 常见污染。

用法：
  python3 verify.py <workdir> [--since <unix_ts>] [--json]

退出码：
  0 = 全部通过
  1 = 发现问题（详情见输出）
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import py_compile
import subprocess
import sys
import tempfile
import time


def find_py_files(root: str, since: float | None) -> list[str]:
    out = []
    skip = {"__pycache__", ".git", ".pytest_cache", ".venv", "node_modules"}
    for dp, dirs, fns in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip]
        for fn in fns:
            if not fn.endswith(".py"):
                continue
            p = os.path.join(dp, fn)
            try:
                if since is not None and os.path.getmtime(p) < since:
                    continue
            except OSError:
                continue
            out.append(p)
    return sorted(out)


def check_file(path: str) -> list[str]:
    """返回问题列表（空表示通过）。"""
    problems: list[str] = []
    try:
        src = open(path, encoding="utf-8", errors="ignore").read()
    except OSError as e:
        return [f"无法读取: {e}"]

    # 1) 语法
    try:
        ast.parse(src)
    except SyntaxError as e:
        problems.append(f"语法错误 L{e.lineno}: {e.msg}")

    # 2) Markdown 围栏混入（hand 常见错误）
    if "```" in src:
        line = next((i + 1 for i, l in enumerate(src.splitlines()) if "```" in l), 0)
        problems.append(f"混入 Markdown 围栏（L{line}）")

    # 3) 非代码内容混入（中文说明段落出现在代码位置）
    non_comment_cn = 0
    for i, l in enumerate(src.splitlines(), 1):
        s = l.strip()
        if not s or s.startswith("#") or s.startswith('"') or s.startswith("'"):
            continue
        if s.startswith("```") or s.startswith("|") or s.startswith("- ") or s.startswith("* "):
            non_comment_cn += 1
    if non_comment_cn >= 3:
        problems.append(f"疑似混入 {non_comment_cn} 行非代码内容（表格/列表）")

    # 4) 是否为空洞实现（整文件只有 pass / ...）
    try:
        tree = ast.parse(src)
        bodies = [n for n in ast.walk(tree)
                  if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        if bodies:
            empty = 0
            for n in bodies:
                stmts = [b for b in n.body if not isinstance(b, ast.Expr)]
                if len(stmts) == 1 and (
                    isinstance(stmts[0], ast.Pass)
                    or (isinstance(stmts[0], ast.Expr)
                        and isinstance(stmts[0].value, ast.Constant)
                        and stmts[0].value.value is Ellipsis)
                ):
                    empty += 1
            if empty == len(bodies) and empty > 0:
                problems.append(f"整文件 {empty} 个定义全为空实现")
    except SyntaxError:
        pass

    return problems


def check_import(root: str, files: list[str]) -> list[str]:
    """尝试导入顶层包（若可识别）。"""
    problems = []
    # 找共同顶层包名
    tops = set()
    for f in files:
        rel = os.path.relpath(f, root)
        if os.sep in rel:
            tops.add(rel.split(os.sep)[0])
    tops.discard("tests")
    tops.discard("test")
    for top in sorted(tops):
        if not os.path.isdir(os.path.join(root, top)):
            continue
        code = (f"import sys; sys.path.insert(0, {root!r}); "
                f"import {top}; print('OK')")
        p = subprocess.run([sys.executable, "-c", code],
                           capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            tail = (p.stderr.strip().splitlines() or ["unknown"])[-1]
            problems.append(f"import {top} 失败: {tail[:150]}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--since", type=float, default=None,
                    help="只检查此 unix 时间戳之后修改的文件")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    root = os.path.abspath(a.workdir)
    files = find_py_files(root, a.since)
    if not files:
        out = {"ok": True, "checked": 0, "files": [], "problems": [],
               "note": "没有新增/修改的 .py 文件"}
        print(json.dumps(out, ensure_ascii=False) if a.json else "  ✓ 没有新增 .py 文件")
        return 0

    per_file: dict[str, list[str]] = {}
    for f in files:
        probs = check_file(f)
        if probs:
            per_file[os.path.relpath(f, root)] = probs

    import_probs = check_import(root, files)

    ok = not per_file and not import_probs
    result = {
        "ok": ok,
        "checked": len(files),
        "files": [os.path.relpath(f, root) for f in files],
        "problems": per_file,
        "import_problems": import_probs,
    }

    if a.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"  检查 {len(files)} 个文件")
        if ok:
            print("  ✓ 全部通过")
            for f in result["files"][:8]:
                print(f"    ✓ {f}")
            if len(result["files"]) > 8:
                print(f"    … 还有 {len(result['files']) - 8} 个")
        else:
            for f, probs in per_file.items():
                print(f"  ✗ {f}")
                for p in probs:
                    print(f"      - {p}")
            for p in import_probs:
                print(f"  ✗ {p}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())