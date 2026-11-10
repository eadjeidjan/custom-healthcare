"""Units shown to people. Body temperature is stored in °C and always shown in °C and °F."""


def c_to_f(c: float) -> float:
    return c * 9 / 5 + 32


def temp(c: float, digits: int = 1) -> str:
    """38.5 -> '38.5 °C (101.3 °F)'."""
    return f"{c:.{digits}f} °C ({c_to_f(c):.{digits}f} °F)"
