const os = require("node:os");

os.userInfo = () => ({
  uid: -1,
  gid: -1,
  username: process.env.USERNAME || "codex",
  homedir: process.env.USERPROFILE || process.cwd(),
  shell: null
});
