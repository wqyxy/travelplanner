export function validatePasswordChange(newPassword: string, confirmation: string) {
  if (newPassword.length < 6) return "新密码至少需要 6 个字符。";
  if (newPassword !== confirmation) return "两次输入的新密码不一致。";
  return "";
}
