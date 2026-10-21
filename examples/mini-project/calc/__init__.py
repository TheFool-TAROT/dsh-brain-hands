"""基础计算。"""
from __future__ import annotations


class CalcError(Exception):
    """项目基础异常。"""


def add(a: int, b: int) -> int:
    """返回两数之和。"""
    return a + b


def div(a: int, b: int) -> float:
    """返回 a / b，除数为 0 时抛 CalcError。"""
    if b == 0:
        raise CalcError("除数不能为 0")
    return a / b
