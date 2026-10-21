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
import io
import tokenize


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

    # 用 tokenize 标出字符串（docstring）占用的行范围，避免把文档里的
    # Markdown 示例误判为「代码污染」
    string_lines: set[int] = set()
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type == tokenize.STRING:
                for ln in range(tok.start[0], tok.end[0] + 1):
                    string_lines.add(ln)
    except Exception:
        pass

    # 2) Markdown 围栏混入（只在代码区检测，docstring 内的示例不算）
    for i, l in enumerate(src.splitlines(), 1):
        if "```" in l and i not in string_lines:
            problems.append(f"混入 Markdown 围栏（L{i}，代码区）")
            break

    # 3) 非代码内容混入（代码区出现表格/列表；docstring 内的不算）
    non_code = 0
    for i, l in enumerate(src.splitlines(), 1):
        if i in string_lines:
            continue
        st = l.strip()
        if not st or st.startswith("#"):
            continue
        if st.startswith("|") or st.startswith("- ") or st.startswith("* ") or st.startswith("```"):
            non_code += 1
    if non_code >= 3:
        problems.append(f"代码区混入 {non_code} 行非代码内容（表格/列表）")

    # 3.5) 文件实质为空：只有省略号/pass/注释/空白
    meaningful = []
    try:
        tree = ast.parse(src)
        for node in tree.body:
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
                continue          # 文档字符串、... 之类
            if isinstance(node, ast.Pass):
                continue
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                meaningful.append("import")
                continue
            meaningful.append(type(node).__name__)
    except SyntaxError:
        pass
    is_init = os.path.basename(path) == "__init__.py"
    if not meaningful and len(src.strip()) < 40:
        # 空的 __init__.py 是 Python 惯例，不算问题
        if not is_init:
            problems.append(f"文件实质为空（{len(src.strip())} 字节，无任何定义）")

    # 4) 是否为空洞实现（整文件只有 pass / ...）
    try:
        tree = ast.parse(src)
        # 只看函数（类本身不算：有方法的类不是空实现）
        fns = [n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
               and n.name not in ("__init__",)]
        if fns:
            empty = 0
            for n in fns:
                stmts = [b for b in n.body if not isinstance(b, ast.Expr)]
                if len(stmts) == 1 and (
                    isinstance(stmts[0], ast.Pass)
                    or (isinstance(stmts[0], ast.Expr)
                        and isinstance(stmts[0].value, ast.Constant)
                        and stmts[0].value.value is Ellipsis)
                ):
                    empty += 1
            if empty == len(fns) and empty > 0:
                problems.append(f"整文件 {empty} 个函数全为空实现")
    except SyntaxError:
        pass

    return problems


def _all_packages(root: str) -> list[str]:
    """找出 root 下所有含 __init__.py 的目录，转成可 import 的模块路径。"""
    pkgs = []
    skip = {"__pycache__", ".git", ".venv", "venv", "node_modules", ".pytest_cache"}
    for dp, dirs, fns in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip]
        if "__init__.py" not in fns:
            continue
        rel = os.path.relpath(dp, root)
        if rel == ".":
            continue
        parts = [p for p in rel.split(os.sep) if p and not p.startswith(".")]
        if not parts:
            continue
        if parts[0] in ("tests", "test", "docs", "examples"):
            continue
        pkgs.append(".".join(parts))
    return sorted(pkgs)


def check_import(root: str, files: list[str]) -> list[str]:
    """逐个导入所有子包——只测顶层包会漏掉 __init__.py 里的坏导入。"""
    problems = []
    pkgs = _all_packages(root)
    if not pkgs:
        return problems
    # 一次性把 sys.path 设好，逐个 import，遇到失败就记录
    code = f"""
import sys, importlib
sys.path.insert(0, {root!r})
failed = []
for name in {pkgs!r}:
    try:
        importlib.import_module(name)
    except Exception as e:
        failed.append((name, type(e).__name__ + ': ' + str(e)[:120]))
for name, err in failed:
    print(f"FAIL\t{{name}}\t{{err}}")
"""
    p = subprocess.run([sys.executable, "-c", code],
                       capture_output=True, text=True, timeout=120)
    for line in (p.stdout or "").splitlines():
        if not line.startswith("FAIL\t"):
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        name, err = parts[1], parts[2]
        if "relative import" in err or "beyond top-level" in err:
            continue
        problems.append(f"import {name} 失败: {err[:150]}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--since", type=float, default=None,
                    help="只检查此 unix 时间戳之后修改的文件")
    ap.add_argument("--expect", default="",
                    help="逗号分隔的期望函数/类名，缺一个就报错")
    ap.add_argument("--snapshot",
                    help="派单前的 .py 文件清单，用于区分新增/修改")
    ap.add_argument("--expect-path", default="",
                    help="逗号分隔的期望文件路径，未创建就报错")
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

    # 收集每个文件定义的公开符号，附在结果里供 brain 核对
    symbols: dict[str, list[str]] = {}
    for f in files:
        try:
            tree = ast.parse(open(f, encoding="utf-8", errors="ignore").read())
        except SyntaxError:
            continue
        names = []
        for n in tree.body:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.append(n.name)
        rel = os.path.relpath(f, root)
        symbols[rel] = names if names else ["(无顶层定义)"]

    # 检查期望的符号是否都存在
    missing: list[str] = []
    expects = [x.strip() for x in a.expect.split(",") if x.strip()]
    if expects:
        defined: set[str] = set()
        for f in files:
            try:
                tree = ast.parse(open(f, encoding="utf-8", errors="ignore").read())
            except SyntaxError:
                continue
            for n in ast.walk(tree):
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    defined.add(n.name)
        missing = [e for e in expects if e not in defined]

    # 区分新增 / 修改
    before: set[str] | None = None
    if a.snapshot:
        try:
            before = {ln.strip() for ln in open(a.snapshot, encoding="utf-8") if ln.strip()}
        except OSError:
            before = None
    rel_files = [os.path.relpath(f, root) for f in files]
    if before is not None:
        added = [f for f in rel_files if f not in before]
        modified = [f for f in rel_files if f in before]
    else:
        added, modified = rel_files, []

    # 检查 brief 里要求的文件路径是否真的存在
    missing_paths: list[str] = []
    expects_path = [x.strip() for x in a.expect_path.split(",") if x.strip()]
    if expects_path:
        for ep in expects_path:
            full = ep if os.path.isabs(ep) else os.path.join(root, ep)
            if not os.path.exists(full):
                missing_paths.append(ep)

    ok = not per_file and not import_probs and not missing and not missing_paths
    result = {
        "ok": ok,
        "checked": len(files),
        "files": [os.path.relpath(f, root) for f in files],
        "symbols": symbols,
        "problems": per_file,
        "import_problems": import_probs,
        "expected": expects,
        "missing": missing,
        "expected_paths": expects_path,
        "missing_paths": missing_paths,
        "added": added,
        "modified": modified,
    }

    if a.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        if before is not None:
            print(f"  检查 {len(files)} 个文件（新增 {len(added)} / 修改 {len(modified)}）")
        else:
            print(f"  检查 {len(files)} 个文件")
        if ok:
            print("  ✓ 全部通过")
            for f in result["files"][:8]:
                syms = result["symbols"].get(f) or []
                print(f"    ✓ {f}")
                if syms:
                    print(f"        定义: {', '.join(syms[:6])}")
            if len(result["files"]) > 8:
                print(f"    … 还有 {len(result['files']) - 8} 个")
        else:
            for f, probs in per_file.items():
                print(f"  ✗ {f}")
                for p in probs:
                    print(f"      - {p}")
            for p in import_probs:
                print(f"  ✗ {p}")
            if missing:
                print(f"  ✗ 缺少期望的定义: {', '.join(missing)}")
            if missing_paths:
                print(f"  ✗ 期望的文件未创建: {', '.join(missing_paths)}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())