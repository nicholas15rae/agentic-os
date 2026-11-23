@echo off
rem Build Hunyuan3D-2's texture extensions (custom_rasterizer: CUDA; differentiable_renderer: C++).
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
set CUDA_HOME=F:\hunyuan3d\cudatk\.pixi\envs\default\Library
set CUDA_PATH=%CUDA_HOME%
set PATH=%CUDA_HOME%\bin;%PATH%
set DISTUTILS_USE_SDK=1
set TORCH_CUDA_ARCH_LIST=8.6
set MAX_JOBS=6
set PY=F:\hunyuan3d\.venv\Scripts\python.exe
nvcc --version
cd /d F:\hunyuan3d\Hunyuan3D-2\hy3dgen\texgen\custom_rasterizer
%PY% -m pip --version >nul 2>&1 || %PY% -m ensurepip
%PY% -m pip install --no-build-isolation . || exit /b 1
cd /d F:\hunyuan3d\Hunyuan3D-2\hy3dgen\texgen\differentiable_renderer
%PY% -m pip install --no-build-isolation . || exit /b 1
echo BUILD_TEXGEN_DONE
