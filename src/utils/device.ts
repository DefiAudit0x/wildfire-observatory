export function getDeviceId(): string {
  let id = sessionStorage.getItem("device_id");
  if (!id) {
    id = `web_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
    sessionStorage.setItem("device_id", id);
  }
  return id;
}