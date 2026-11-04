"""Minimal helpers adapted from official SCNet, MIT licensed; see LICENSE."""

import torch


def center_trim(tensor: torch.Tensor, reference: torch.Tensor | int) -> torch.Tensor:
    ref_size = reference.size(-1) if isinstance(reference, torch.Tensor) else reference
    delta = tensor.size(-1) - ref_size
    if delta < 0:
        raise ValueError(f"tensor must be larger than reference. Delta is {delta}.")
    if delta:
        tensor = tensor[..., delta // 2 : -(delta - delta // 2)]
    return tensor


class DummyPoolExecutor:
    """Synchronous executor used by the upstream chunk inference implementation."""

    class DummyResult:
        def __init__(self, function, *args, **kwargs):
            self.function = function
            self.args = args
            self.kwargs = kwargs

        def result(self):
            return self.function(*self.args, **self.kwargs)

    def __init__(self, workers=0):
        del workers

    def submit(self, function, *args, **kwargs):
        return self.DummyResult(function, *args, **kwargs)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return None
