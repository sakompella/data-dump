import { createApp } from './app';

export { UserData } from './user-data';

export default createApp({ dev: import.meta.env.DEV });
