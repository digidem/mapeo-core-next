CREATE TABLE `localDeviceInfo` (
	`deviceId` text NOT NULL,
	`deviceInfo` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projectSettings_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projectKeys` (
	`projectId` text PRIMARY KEY NOT NULL,
	`projectPublicId` text NOT NULL,
	`projectInviteId` blob NOT NULL,
	`keysCipher` blob NOT NULL,
	`projectInfo` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projectSettings` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`name` text,
	`defaultPresets` text,
	`configMetadata` text,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `localDeviceInfo_deviceId_unique` ON `localDeviceInfo` (`deviceId`);