import { getApp } from '../lib/runtime.js';

export const GET = (request) => getApp().downloads(request);
