/**
 * RAM disk utility for copying model files to a fast temporary mount (e.g., tmpfs).
 * Validates directory existence, writability, and available space before copying.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, accessSync, constants } from 'node:fs'
import Logger from './logger.js'

/**
 * Recursively calculate the total size of all files in a directory (in bytes).
 * @param {string} dir - Directory path to measure
 * @returns {number} Total size in bytes
 */
function getDirectorySize(dir) {
    let total = 0
    try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
            const fullPath = `${dir}/${entry.name}`
            if (entry.isDirectory()) {
                total += getDirectorySize(fullPath)
            } else {
                total += statSync(fullPath).size
            }
        }
    } catch {
        // If we can't read a subdirectory, skip it
    }
    return total
}

/**
 * Format bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`
}

/**
 * Set up the RAM disk by validating and copying model files.
 *
 * @param {string} sourceDir - Original model directory (DIR_MODEL)
 * @param {string} targetDir - RAM disk directory (DIR_RAMDISK_MODEL)
 * @param {Logger} [log] - Logger instance
 * @returns {boolean} true if setup succeeded
 * @throws Process exit on failure
 */
export function setupRamDisk(sourceDir, targetDir, log) {
    const logger = log || new Logger({ namespace: 'RamDisk' })

    // Step 1: Check if target directory exists; create if not
    let dirExists = false
    try {
        statSync(targetDir)
        dirExists = true
        logger.log(`RAM disk directory already exists: ${targetDir}`)
    } catch {
        try {
            mkdirSync(targetDir, { recursive: true })
            logger.log(`Created RAM disk directory: ${targetDir}`)
            dirExists = false // We created it, so we should clean it up entirely on shutdown
        } catch (err) {
            logger.error(`ERROR: Cannot create RAM disk directory '${targetDir}': ${err.message}`)
            logger.error('Please ensure the parent path exists and is writable, or unset DIR_RAMDISK_MODEL.')
            process.exit(1)
        }
    }

    // Step 2: Verify writability
    try {
        accessSync(targetDir, constants.W_OK | constants.R_OK | constants.X_OK)
    } catch {
        logger.error(`ERROR: RAM disk directory '${targetDir}' is not readable/writable/executable by this process`)
        logger.error('Please check directory permissions, or unset DIR_RAMDISK_MODEL.')
        process.exit(1)
    }

    // Step 3: Compare free space vs. source size
    const sourceSize = getDirectorySize(sourceDir)
    logger.log(`Model directory size: ${formatBytes(sourceSize)}`)

    let freeSpace
    try {
        // Use df command to get available space in bytes (-B1 for 1-byte blocks)
        const output = execSync(`df -B1 "${targetDir}"`, { encoding: 'utf-8' }).trim()
        // Output format: Filesystem  1B-blocks  Used Available Mounted on
        const lines = output.split('\n')
        if (lines.length >= 2) {
            const parts = lines[1].split(/\s+/)
            freeSpace = parseInt(parts[3], 10) || 0
        } else {
            throw new Error('Unexpected df output format')
        }
    } catch (err) {
        logger.error(`ERROR: Cannot determine free space for '${targetDir}': ${err.message}`)
        logger.error('Proceeding without space check, but this may cause issues.')
        freeSpace = sourceSize + 1 // Allow to proceed
    }

    logger.log(`Free space on RAM disk mount: ${formatBytes(freeSpace)}`)

    if (freeSpace < sourceSize) {
        logger.error(`ERROR: Insufficient space on RAM disk '${targetDir}'`)
        logger.error(`  Required: ${formatBytes(sourceSize)}, Available: ${formatBytes(freeSpace)}`)
        logger.error('Please increase the tmpfs/RAM disk size, or unset DIR_RAMDISK_MODEL.')
        process.exit(1)
    }

    // Step 4: Copy model files from source to target
    try {
        cpSync(sourceDir, targetDir, { recursive: true })
        logger.log(`Copied models to RAM disk: ${targetDir}`)
    } catch (err) {
        logger.error(`ERROR: Failed to copy models to RAM disk '${targetDir}': ${err.message}`)
        logger.error('Please ensure the source directory is readable and the target is writable.')
        process.exit(1)
    }

    return dirExists
}

/**
 * Clean up the RAM disk directory by removing copied contents.
 *
 * @param {string} targetDir - RAM disk directory path
 * @param {boolean} dirExistedBeforeSetup - true if the directory existed before we created it
 * @param {Logger} [log] - Logger instance
 */
export function cleanupRamDisk(targetDir, dirExistedBeforeSetup, log) {
    const logger = log || new Logger({ namespace: 'RamDisk' })

    try {
        if (dirExistedBeforeSetup) {
            // Directory existed before us — only remove contents
            const entries = readdirSync(targetDir, { withFileTypes: true })
            for (const entry of entries) {
                const fullPath = `${targetDir}/${entry.name}`
                rmSync(fullPath, { recursive: true, force: true })
            }
            logger.log(`Cleaned up RAM disk contents: ${targetDir}`)
        } else {
            // We created the directory — remove it entirely
            rmSync(targetDir, { recursive: true, force: true })
            logger.log(`Removed RAM disk directory: ${targetDir}`)
        }
    } catch (err) {
        logger.error(`WARNING: Failed to clean up RAM disk '${targetDir}': ${err.message}`)
    }
}