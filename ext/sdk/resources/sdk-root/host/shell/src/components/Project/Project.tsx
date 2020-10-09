import React from 'react';
import { AssetCreator } from './AssetCreator/AssetCreator';
import { ProjectContext } from '../../contexts/ProjectContext';
import { ProjectExplorer } from './ProjectExplorer/ProjectExplorer';
import { projectConfigIcon, resourceIcon } from '../../constants/icons';
import { Server } from '../Server/Server';
import s from './Project.module.scss';


export const Project = React.memo(() => {
  const {
    project,
    projectResources,
    assetCreatorOpen,
  } = React.useContext(ProjectContext);

  const showProjectExplorer = !!project?.fsTree.entries.length;

  const resourcesCount = Object.keys(projectResources).length;

  return (
    <>
      {assetCreatorOpen && (
        <AssetCreator />
      )}

      <div className={s.root}>
        <div className={s.header}>
          <div className={s.title}>
            <span className={s.name}>
              {project?.manifest.name || ''}
            </span>
          </div>

          <div className={s.extra}>
            <div className={s.stats}>
              <span title={`Resources in this project: ${resourcesCount}`}>
                {resourceIcon} {resourcesCount}
              </span>
            </div>

            <div className={s.server}>
              <Server />
            </div>
          </div>
        </div>

        {showProjectExplorer && (
          <ProjectExplorer />
        )}
      </div>
    </>
  );
});
