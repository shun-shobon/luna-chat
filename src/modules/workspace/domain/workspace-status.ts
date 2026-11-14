export type TrashFolderStatus = Readonly<{
	date: string;
	deleteOn: string;
	entries: readonly string[];
}>;

export type WorkspaceStatus = Readonly<{
	disk: Readonly<{ totalBytes: number; freeBytes: number }>;
	trash: readonly TrashFolderStatus[];
}>;
