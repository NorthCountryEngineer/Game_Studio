import { coreRequest, coreAdminSession, coreAccountAdminSession, coreAgentAdminSession, coreLogout, coreSession, isCore } from './core';
import { localAsset } from './local';
export { isCore };
export const isCloud = isCore;
export const editorSession = async () => isCore ? coreSession() : true;
export const adminSession = async () => isCore ? coreAdminSession() : true;
export const accountAdminSession = async () => isCore ? coreAccountAdminSession() : true;
export const agentAdminSession = async () => isCore ? coreAgentAdminSession() : true;
export const logout = async () => { if (isCore) await coreLogout(); };
export async function assetURL(key: string) { return isCore ? (await coreRequest<{url:string}>(`/media/read?key=${encodeURIComponent(key)}`)).url : URL.createObjectURL(await localAsset(key)); }
