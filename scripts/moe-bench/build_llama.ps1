# Build one llama.cpp branch with CUDA 13.4 (sm_89, RTX 4060) on Windows/MSVC and
# install the binaries plus CUDA runtime DLLs into C:\qwen3-forge-stage\tools\llama-<name>-<sha>.
param(
    [Parameter(Mandatory)] [string]$Branch,     # local branch in C:\build\llama.cpp
    [Parameter(Mandatory)] [string]$Name,       # short label for the output folder
    [int]$Jobs = 6,
    [switch]$Force,  # the model pipeline builds on demand; the older chain's loop is skipped
    [string]$Targets = 'llama-server llama-bench llama-imatrix llama-quantize llama-gguf-split llama-cli'
)
# 'Continue', not 'Stop': in Windows PowerShell 5.1, git and cmake progress text on stderr
# becomes an error record when the caller redirects streams, and 'Stop' turned that
# into a fake failure (2026-10-03). Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'
if ((Test-Path 'C:\build\SKIP_CHAIN_BUILDS') -and -not $Force) { "skipped $Branch (pipeline builds on demand)"; return }
$repo  = 'C:\build\llama.cpp'
$wt    = "C:\build\wt-$Name"
$cuda  = 'C:\cuda\13.4.2'
$vcvars = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat'
$vsBin = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake'
# vcvars64.bat calls vswhere.exe; detached shells may not have its folder on PATH.
$env:PATH = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:PATH"

if (-not (Test-Path $wt)) { cmd /c "git -C `"$repo`" worktree add --force `"$wt`" $Branch 2>&1" | Out-Null }
$sha = (cmd /c "git -C `"$wt`" rev-parse --short HEAD 2>nul").Trim()
if (-not $sha) { throw "no worktree for $Branch at $wt" }
$out = "C:\qwen3-forge-stage\tools\llama-$Name-$sha"   # D: (USB) went offline 2026-10-04

$cfg = @(
    "`"$vsBin\CMake\bin\cmake.exe`" -S `"$wt`" -B `"$wt\build`" -G Ninja",
    "-DCMAKE_MAKE_PROGRAM=`"$vsBin\Ninja\ninja.exe`"",
    '-DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89',
    "-DCUDAToolkit_ROOT=`"$cuda`" -DCMAKE_CUDA_COMPILER=`"$cuda\bin\nvcc.exe`"",
    '-DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF'
) -join ' '
$bld = "`"$vsBin\CMake\bin\cmake.exe`" --build `"$wt\build`" --config Release -j $Jobs --target $Targets"

$env:CUDA_PATH = $cuda
cmd /c "call `"$vcvars`" >nul && $cfg && $bld"
if ($LASTEXITCODE -ne 0) { throw "build failed for $Branch (exit $LASTEXITCODE)" }

New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$wt\build\bin\*" $out -Recurse -Force
Copy-Item "$cuda\bin\x64\cudart64_*.dll", "$cuda\bin\x64\cublas*64_*.dll" $out -Force
"built $Branch -> $out"
