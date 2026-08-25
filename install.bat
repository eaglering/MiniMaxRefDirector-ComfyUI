@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title MiniMaxRefDirector-ComfyUI Installer

set "SELF_DIR=%~dp0"
for %%I in ("%SELF_DIR%.") do set "SELF_DIR=%%~fI"
set "SELF_NAME=MiniMaxRefDirector-ComfyUI"
set "SKIP_DEPS=0"
if /i "%~1"=="-skipdeps" set "SKIP_DEPS=1"

echo ============================================================
echo   MiniMaxRefDirector-ComfyUI 一键安装脚本
echo   自动检测安装位置，并下载依赖的 ComfyUI 自定义节点
echo ============================================================
echo.

:: ---------- 1. 判断当前是否已作为插件安装（位于 custom_nodes 下） ----------
for %%I in ("%SELF_DIR%\..") do set "PARENT=%%~fI"
for %%J in ("%PARENT%.") do set "PARENT_NAME=%%~nxJ"
if /i "%PARENT_NAME%"=="custom_nodes" (
    echo [OK] 已检测到本插件安装于 custom_nodes 目录：
    echo      %SELF_DIR%
    for %%I in ("%SELF_DIR%\..\..") do set "COMFY_ROOT=%%~fI"
    set "PLUGIN_DIR=%SELF_DIR%"
    goto :stage_deps
)

echo [信息] 当前目录不在 ComfyUI/custom_nodes 下，脚本将自动安装本插件。
echo.

:: ---------- 2. 定位 ComfyUI 根目录 ----------
set "COMFY_ROOT="
for %%D in ("%SELF_DIR%\..\.." "%SELF_DIR%\..\..\..") do (
    if not defined COMFY_ROOT if exist "%%~fD\custom_nodes" set "COMFY_ROOT=%%~fD"
)
if not defined COMFY_ROOT if exist "%SELF_DIR%\..\ComfyUI\custom_nodes" set "COMFY_ROOT=%SELF_DIR%\..\ComfyUI"
if not defined COMFY_ROOT if exist "%SELF_DIR%\..\..\ComfyUI\custom_nodes" set "COMFY_ROOT=%SELF_DIR%\..\..\ComfyUI"

if not defined COMFY_ROOT (
    echo [提示] 未自动检测到 ComfyUI 安装位置。
    set /p "COMFY_ROOT=请输入 ComfyUI 根目录（包含 custom_nodes 的那一层）: "
)
if "%COMFY_ROOT%"=="" (
    echo [错误] 未提供 ComfyUI 根目录，安装中止。
    pause
    exit /b 1
)
for %%I in ("%COMFY_ROOT%") do set "COMFY_ROOT=%%~fI"
if not exist "%COMFY_ROOT%\custom_nodes" (
    echo [错误] 未找到 "%COMFY_ROOT%\custom_nodes"，请确认路径是否正确。
    pause
    exit /b 1
)

:: ---------- 3. 复制本插件到 custom_nodes ----------
set "PLUGIN_DIR=%COMFY_ROOT%\custom_nodes\%SELF_NAME%"
if exist "%PLUGIN_DIR%" (
    echo [信息] %SELF_NAME% 已存在于 %PLUGIN_DIR%，跳过复制。
) else (
    echo [操作] 复制本插件到 %PLUGIN_DIR% ...
    robocopy "%SELF_DIR%" "%PLUGIN_DIR%" /E /XD .git __pycache__ node_modules /NFL /NDL /NJH /NJS >nul
    if errorlevel 8 (
        echo [错误] 复制失败（robocopy 退出码 %errorlevel%）。
        pause
        exit /b 1
    )
)

:: ---------- 4. 安装依赖的第三方 custom_nodes 插件 ----------
:stage_deps
set "CUSTOM_NODES_DIR=%COMFY_ROOT%\custom_nodes"

:: 选择 Python 解释器（优先 portable 版的 python_embeded）
set "PY=python"
if exist "%COMFY_ROOT%\..\python_embeded\python.exe" set "PY=%COMFY_ROOT%\..\python_embeded\python.exe"
if exist "%COMFY_ROOT%\..\..\python_embeded\python.exe" set "PY=%COMFY_ROOT%\..\..\python_embeded\python.exe"
:: 将 pip 所在 Scripts 目录加入 PATH，保证子插件 install.bat 中的 pip 命令可用
if exist "%PY%\..\Scripts\pip.exe" (
    set "PATH=%PY%\..\Scripts;%PATH%"
) else (
    for /f "delims=" %%P in ('where python 2^>nul') do (
        if exist "%%~dpPScripts\pip.exe" set "PATH=%%~dpPScripts;%PATH%"
    )
)

:: git 可用性检测
set "GIT_OK=0"
where git >nul 2>nul && set "GIT_OK=1"
if "%GIT_OK%"=="0" echo [信息] 未检测到 git，将使用 PowerShell 下载 ZIP 方式安装依赖。

if "%SKIP_DEPS%"=="1" (
    echo [信息] 已指定 -skipdeps，跳过第三方自定义节点下载。
    goto :install_self
)

echo.
echo [阶段] 检查 / 下载依赖的自定义节点插件 ...
echo.
call :install_dep ComfyUI-VideoHelperSuite https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite
call :install_dep rgthree-comfy https://github.com/rgthree/rgthree-comfy
call :install_dep ComfyUI-Easy-Use https://github.com/yolain/ComfyUI-Easy-Use
call :install_dep ComfyUI-KJNodes https://github.com/kijai/ComfyUI-KJNodes
call :install_dep TE-Speed-MiniMaxH3 https://github.com/tl2012tl/TE-Speed-MiniMaxH3
call :install_dep ComfyUI-H3-Motion-Context-MultiRef https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef
call :install_dep ComfyUI-H3-Latent-Upscaler-Mamad8 https://github.com/mamad8c/ComfyUI-H3-Latent-Upscaler-Mamad8
call :install_dep ComfyUI-MiniMaxH3_LatentUpscaler https://github.com/Tr1dae/ComfyUI-MiniMaxH3_LatentUpscaler

:: ---------- 5. 安装本插件自身依赖 ----------
:install_self
echo.
echo [阶段] 安装 %SELF_NAME% 自身依赖 ...
pushd "%PLUGIN_DIR%"
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 echo [警告] 依赖安装失败，请手动执行: "%PY%" -m pip install -r "%PLUGIN_DIR%\requirements.txt"
popd

echo.
echo ============================================================
echo   安装完成！
echo   插件位置: %PLUGIN_DIR%
echo   请重启 ComfyUI 以加载插件。
echo ============================================================
pause
exit /b 0

:: ==================== 子例程 ====================

:install_dep
set "DEP_NAME=%~1"
set "DEP_URL=%~2"
set "DEP_DIR=%CUSTOM_NODES_DIR%\%DEP_NAME%"
if exist "%DEP_DIR%" (
    echo [跳过] %DEP_NAME% 已存在：%DEP_DIR%
    goto :eof
)

:: 方式一：git clone
if "%GIT_OK%"=="1" (
    echo [操作] git clone %DEP_NAME% ...
    git clone --depth 1 "%DEP_URL%" "%DEP_DIR%" >nul 2>nul
    if not errorlevel 1 (
        call :install_dep_reqs "%DEP_DIR%"
        goto :eof
    )
    echo [警告] git clone 失败，改用 PowerShell 下载 ZIP ...
)

:: 方式二：PowerShell 下载 ZIP 并解压
echo [操作] 下载 %DEP_NAME% (ZIP) ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $tmp='%TEMP%\%DEP_NAME%.zip'; foreach($br in @('main','master')){try{Invoke-WebRequest -Uri ('%DEP_URL%/archive/refs/heads/'+$br+'.zip') -OutFile $tmp; break}catch{}}; if(!(Test-Path $tmp)){throw 'ZIP download failed'}; Expand-Archive -Path $tmp -DestinationPath '%CUSTOM_NODES_DIR%' -Force; Remove-Item $tmp -Force"
if errorlevel 1 (
    echo [错误] %DEP_NAME% 下载失败。
    echo         请手动安装：在 %CUSTOM_NODES_DIR% 下执行
    echo         git clone %DEP_URL%
    goto :eof
)
for /d %%D in ("%CUSTOM_NODES_DIR%\%DEP_NAME%-*") do (
    if not exist "%DEP_DIR%" ren "%%~fD" "%DEP_NAME%" 2>nul
)
if exist "%DEP_DIR%" (
    call :install_dep_reqs "%DEP_DIR%"
) else (
    echo [警告] %DEP_NAME% 解压后目录名不符，请手动确认。
)
goto :eof

:install_dep_reqs
set "DEP_REQ=%~1"
if exist "%DEP_REQ%\requirements.txt" (
    echo [安装] 依赖: %DEP_REQ%\requirements.txt
    "%PY%" -m pip install -r "%DEP_REQ%\requirements.txt"
)
if exist "%DEP_REQ%\install.bat" (
    pushd "%DEP_REQ%"
    call install.bat
    popd
)
goto :eof
