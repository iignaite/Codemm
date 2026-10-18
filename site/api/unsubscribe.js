import { getApp } from '../lib/runtime.js';

export const POST = (request) => getApp().unsubscribe(request);
