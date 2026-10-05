import subprocess
from pathlib import Path

project_dir = Path(r'E:/Chandelier In the Midnight with an Idoit and a Cup/Novel-blog')
npm_cmd = r'E:/Chandelier In the Midnight with an Idoit and a Cup/Node_js/npm.cmd'
result = subprocess.run([npm_cmd, 'run', 'build'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(project_dir))

log_path = project_dir / 'buildlog.txt'
log_path.write_text(result.stdout + f'\nEXIT:{result.returncode}\n', encoding='utf-8')
print(f'WROTE:{log_path}')
print(f'EXIT:{result.returncode}')
