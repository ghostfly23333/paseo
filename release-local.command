#!/bin/zsh -l
cd "${0:A:h}" || exit 1
npm run release:local
result=$?
if [[ $result -ne 0 ]]; then
  printf '\n发版失败，请查看上方日志。按回车关闭。\n'
  read
fi
exit $result
