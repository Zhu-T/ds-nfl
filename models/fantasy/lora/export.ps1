<#
Turns a trained LoRA adapter into an Ollama model.

    models\fantasy\lora\export.ps1 -Adapter C:\Users\Tony\ds-nfl-lora\run1\epoch-2

Converts the PEFT adapter to GGUF with llama.cpp's converter, writes a Modelfile
beside it that applies the adapter to deepseek-r1:14b, and creates the model.
No SYSTEM prompt: the adapter was trained on the app's own prompts alone.
#>
param(
    [Parameter(Mandatory)] [string] $Adapter,
    [string] $Name = 'ds-nfl-lora',
    [string] $Work = "$env:USERPROFILE\ds-nfl-lora"
)
# Failures are caught by exit code below. 'Stop' would instead abort on the
# converter's first log line, which Windows PowerShell treats as an error
# because it arrives on stderr.

$python = Join-Path $Work 'venv\Scripts\python.exe'
$llama = Get-ChildItem $Work -Directory -Filter 'llama.cpp*' | Select-Object -First 1
if (-not $llama) { throw "llama.cpp source not found under $Work" }

$gguf = Join-Path (Resolve-Path $Adapter) 'adapter.gguf'
& $python (Join-Path $llama.FullName 'convert_lora_to_gguf.py') --base (Join-Path $Work 'base') --outtype f16 --outfile $gguf $Adapter
if ($LASTEXITCODE -ne 0) { throw 'Converting the adapter to GGUF failed.' }

$modelfile = Join-Path (Resolve-Path $Adapter) 'Modelfile'
@"
FROM deepseek-r1:14b
ADAPTER $gguf
PARAMETER temperature 0.2
PARAMETER num_ctx 8192
"@ | Set-Content -Encoding ascii $modelfile

ollama create $Name -f $modelfile
if ($LASTEXITCODE -ne 0) { throw "ollama create $Name failed." }
