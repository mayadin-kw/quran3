"""Export the pinned Quranic phonetic CTC checkpoint to browser ONNX.

Requires torch, transformers, onnx, onnxruntime in a temporary build venv.
Download revision 65c3ab93446f2f1041a18082433a911e5e154a9d of
TBOGamer22/wav2vec2-quran-phonetics into the input directory first.
"""
import argparse
from pathlib import Path
import torch
from transformers import Wav2Vec2ForCTC
from onnxruntime.quantization import quantize_dynamic, QuantType

parser = argparse.ArgumentParser()
parser.add_argument("model_dir", type=Path)
parser.add_argument("output_dir", type=Path)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

model = Wav2Vec2ForCTC.from_pretrained(args.model_dir).eval()

class LogitsOnly(torch.nn.Module):
    def __init__(self, base):
        super().__init__()
        self.base = base

    def forward(self, input_values):
        return self.base(input_values).logits

output = args.output_dir / "quran-phoneme.float.onnx"
with torch.inference_mode():
    torch.onnx.export(LogitsOnly(model), torch.zeros(1, 16000), output,
        input_names=["input_values"], output_names=["logits"],
        dynamic_axes={"input_values": {1: "samples"}, "logits": {1: "frames"}},
        opset_version=17, dynamo=False)
quantize_dynamic(output, args.output_dir / "quran-phoneme.int8.onnx",
                 weight_type=QuantType.QInt8)
