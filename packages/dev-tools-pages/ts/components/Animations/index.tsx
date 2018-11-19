import * as React from 'react';
import Lottie from 'react-lottie';
import styled from 'styled-components';

import { media } from 'ts/variables';

interface AnimationProps {
    animationData: object;
    width: number;
    height: number;
}

interface AnimationState {
    width?: number | undefined;
    height?: number | undefined;
}

class BaseAnimation extends React.PureComponent<AnimationProps, AnimationState> {
    public state: AnimationState = {
        height: undefined,
        width: undefined,
    };
    private _timeout = undefined as number;
    public componentDidMount(): void {
        this._updateAnimationSize();
        window.addEventListener('resize', this._handleResize);
    }
    public componentWillUnmount(): void {
        window.removeEventListener('resize', this._handleResize);
    }
    public render(): React.ReactNode {
        const { animationData } = this.props;
        const height = this.state.height || this.props.height;
        const width = this.state.width || this.props.width;

        return (
            <Container height={height}>
                <InnerContainer>
                    <Lottie
                        width={width}
                        height={height}
                        options={{
                            loop: true,
                            autoplay: true,
                            animationData,
                        }}
                    />
                </InnerContainer>
            </Container>
        );
    }
    private readonly _handleResize = () => {
        clearTimeout(this._timeout);
        this._timeout = window.setTimeout(this._updateAnimationSize, 50);
    };
    private readonly _updateAnimationSize = () => {
        const windowWidth = window.innerWidth;
        let width;
        let height;
        if (windowWidth <= 1000) {
            const maxWidth = windowWidth + 250;
            const ratio = maxWidth / this.props.width;

            height = Math.round(this.props.height * ratio);
            width = Math.round(this.props.width * ratio);
        }

        this.setState({ width, height });
    };
}

const Container = styled.div`
    width: 100%;
    height: ${(props: { height: number }) => props.height}px;
    position: absolute;
    top: 40%;
    left: 0;
    z-index: -1;
    overflow: hidden;
    ${media.large`
        top: 100%;
        transform: translateY(-50%);
    `};
`;

const InnerContainer = styled.div`
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
`;

export { BaseAnimation };
