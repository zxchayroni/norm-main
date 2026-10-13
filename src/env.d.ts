declare global {
	namespace App {
		interface Locals {
			user: {
				id: string;
				username: string;
				fullName: string;
				role: 'admin' | 'editor' | 'reader';
			} | null;
		}
	}
}

export {};
